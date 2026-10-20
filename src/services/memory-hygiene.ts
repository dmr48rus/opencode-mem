/**
 * Store hygiene: compaction of the marked duplicates, the conflict flags, and
 * the profile items whose support has been forgotten.
 *
 * The soft deduplication marks the near-duplicates but leaves them in place -
 * marking is reversible, and a mark nobody acts on is just a note. Compaction
 * is the step that acts on it: a copy of a cold cluster is folded into its
 * canonical copy and stops surfacing, while the canonical copy stays intact
 * and the fold can be undone.
 *
 * Contradictions are only flagged. Two records that disagree are both true as
 * far as the store knows - which one wins is the owner's decision, not a side
 * effect of a scan. The flag is a pair, a kind and a reason: a value that
 * differs or a term that is negated in one record and not in the other.
 *
 * The profile is a derivate of the facts, so forgetting a fact has to reach
 * it: an item whose only support was forgotten goes with it. An item that
 * another live record still supports stays.
 */
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { log } from "./logger.js";
import type { UserProfileData } from "./user-profile/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Function words: every Russian sentence shares them, so they would make two
 * unrelated records look alike. The negation marker is deliberately not here -
 * it is handled separately, as a marker and not as a word.
 */
const STOP_TOKENS = new Set([
  "это",
  "как",
  "для",
  "если",
  "что",
  "все",
  "вот",
  "уже",
  "еще",
  "ещё",
  "или",
  "при",
  "под",
  "над",
  "без",
  "его",
  "она",
  "они",
  "так",
  "быть",
  "есть",
  "оно",
  "который",
  "которая",
  "которые",
  "этот",
  "эта",
  "эти",
  "того",
  "этом",
  "здесь",
  "там",
  "тоже",
  "только",
  "очень",
  "может",
  "надо",
  "нужно",
  "свой",
  "своя",
  "свои",
  "наш",
  "ваш",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "but",
  "all",
  "any",
  "can",
  "will",
  "would",
  "should",
]);

/** A word that can carry a subject: long enough to mean something. */
function isSignificant(token: string): boolean {
  return token.length >= 4 && !STOP_TOKENS.has(token);
}

/** The words of a text that can carry its subject. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (isSignificant(raw)) tokens.add(raw);
  }
  return tokens;
}

/** How much of the set is shared: two records about the same subject score high. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/** The numbers of a text: a value that differs is a contradiction. */
function extractNumbers(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)?/g) ?? [];
}

/**
 * The terms that the text negates - and only those it never uses plainly.
 * "не использует bun" negates "использует"; "не использует bun, но использует
 * node" negates nothing, because the term is used both ways.
 */
function negatedTerms(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  const negated = new Set<string>();
  const plain = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "не" || word === "not" || word === "no") {
      const term = words[i + 1];
      if (term && isSignificant(term)) negated.add(term);
      // The term after the marker belongs to the negation, not to the plain
      // text: "не требует" negates "требует" and does not use it.
      i += 1;
      continue;
    }
    if (isSignificant(word)) plain.add(word);
  }
  // A term that the text also uses plainly is not negated by it.
  for (const term of [...negated]) {
    if (plain.has(term)) negated.delete(term);
  }
  return negated;
}

type ConflictKind = "value" | "polarity";

type Document = {
  id: string;
  tag: string;
  content: string;
  tokens: Set<string>;
  numbers: string[];
  negated: Set<string>;
};

function detectConflict(
  a: Document,
  b: Document
): {
  kind: ConflictKind;
  confidence: number;
  reason: string;
} | null {
  const confidence = jaccard(a.tokens, b.tokens);
  // Two records only contradict each other when they are about the same thing.
  if (confidence < 0.5) return null;

  // A claim states a value or two. A record with a dozen numbers is a log, and
  // two logs differ in their numbers for reasons that have nothing to do with
  // contradicting each other - timestamps alone make every pair of them a
  // "conflict".
  if (
    a.numbers.length > 0 &&
    b.numbers.length > 0 &&
    a.numbers.length <= 3 &&
    b.numbers.length <= 3
  ) {
    const aSet = new Set(a.numbers);
    const bSet = new Set(b.numbers);
    // One value set inside the other is an elaboration, not a contradiction.
    const aInside = [...aSet].every((number) => bSet.has(number));
    const bInside = [...bSet].every((number) => aSet.has(number));
    const shared = [...aSet].filter((number) => bSet.has(number)).length;
    const differing = aSet.size + bSet.size - 2 * shared;
    if (!aInside && !bInside && differing <= 2) {
      return {
        kind: "value",
        confidence,
        reason: `different values: ${[...aSet].join(", ")} against ${[...bSet].join(", ")}`,
      };
    }
  }

  for (const term of a.negated) {
    if (b.tokens.has(term) && !b.negated.has(term)) {
      return {
        kind: "polarity",
        confidence,
        reason: `"${term}" is negated in one record and not in the other`,
      };
    }
  }
  for (const term of b.negated) {
    if (a.tokens.has(term) && !a.negated.has(term)) {
      return {
        kind: "polarity",
        confidence,
        reason: `"${term}" is negated in one record and not in the other`,
      };
    }
  }
  return null;
}

export type CompactSample = {
  duplicate: string;
  canonical: string;
  ageDays: number;
};

export type CompactResult = {
  dryRun: boolean;
  coldDays: number;
  clusters: number;
  compacted: number;
  restored: number;
  skippedWarm: number;
  samples: CompactSample[];
};

/**
 * Fold the marked duplicates into their canonical copies.
 *
 * Only the cold clusters: a duplicate of this week is still a fresh thought,
 * and folding it away hides what was just written. The canonical copy stays
 * where it is, and the fold is undone by clearing the marker.
 */
export async function compactDuplicates(
  options: { dryRun?: boolean; coldDays?: number; limit?: number; restore?: boolean } = {}
): Promise<CompactResult> {
  const coldDays = Math.max(0, options.coldDays ?? 30);
  const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
  const dryRun = options.dryRun !== false;
  const cutoff = Date.now() - coldDays * DAY_MS;

  await ensureTursoReady();
  const shards = [
    ...(await tursoShardManager.getAllShards("user", "")),
    ...(await tursoShardManager.getAllShards("project", "")),
  ];

  let compacted = 0;
  let restored = 0;
  let clusters = 0;
  let skippedWarm = 0;
  const samples: CompactSample[] = [];

  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoShardManager.ensureShardSchema(db);

    if (options.restore === true) {
      const result = await db.run(
        `UPDATE memories SET compacted_into = NULL WHERE compacted_into IS NOT NULL`
      );
      restored +=
        typeof result === "number"
          ? result
          : Number((result as { rowsAffected?: number })?.rowsAffected ?? 0);
      continue;
    }

    const rows = await db.all(
      `SELECT id, superseded_by, created_at FROM memories
       WHERE superseded_by IS NOT NULL AND compacted_into IS NULL`
    );
    const groups = new Map<string, Array<{ id: string; createdAt: number }>>();
    for (const row of rows) {
      const canonical = String(row.superseded_by);
      const bucket = groups.get(canonical) ?? [];
      bucket.push({ id: String(row.id), createdAt: Number(row.created_at ?? 0) });
      groups.set(canonical, bucket);
    }

    const memberIds = new Set<string>();
    for (const members of groups.values()) {
      for (const member of members) memberIds.add(member.id);
    }

    for (const [canonical, members] of groups) {
      // The canonical copy is itself a duplicate of something else: folding it
      // away would bury the oldest copy under a younger one.
      if (memberIds.has(canonical)) continue;
      const canonicalRow = await db.get<{ created_at?: number }>(
        `SELECT created_at FROM memories WHERE id = ?`,
        [canonical]
      );
      if (!canonicalRow) continue;
      const newest = Math.max(
        Number(canonicalRow.created_at ?? 0),
        ...members.map((member) => member.createdAt)
      );
      if (newest > cutoff) {
        skippedWarm += members.length;
        continue;
      }
      clusters += 1;
      for (const member of members) {
        if (compacted >= limit) break;
        if (!dryRun) {
          await db.run(`UPDATE memories SET compacted_into = ? WHERE id = ?`, [
            canonical,
            member.id,
          ]);
        }
        compacted += 1;
        if (samples.length < 10) {
          samples.push({
            duplicate: member.id,
            canonical,
            ageDays: Math.floor((Date.now() - member.createdAt) / DAY_MS),
          });
        }
      }
    }
  }

  log("Compaction", { dryRun, coldDays, clusters, compacted, restored });
  return { dryRun, coldDays, clusters, compacted, restored, skippedWarm, samples };
}

export type ConflictSample = {
  memoryId: string;
  otherId: string;
  kind: ConflictKind;
  confidence: number;
  reason: string;
};

export type ConflictScanResult = {
  dryRun: boolean;
  scanned: number;
  pairs: number;
  flagged: number;
  samples: ConflictSample[];
};

/**
 * Find the records that contradict each other and flag the pair.
 *
 * Nothing is resolved: both records stay where they are and both stay
 * searchable. The flag says that they disagree, and the owner decides.
 */
export async function scanContradictions(
  options: { dryRun?: boolean; limit?: number } = {}
): Promise<ConflictScanResult> {
  const dryRun = options.dryRun !== false;
  const limit = Math.max(1, Math.min(2000, options.limit ?? 200));

  await ensureTursoReady();
  const shards = [
    ...(await tursoShardManager.getAllShards("user", "")),
    ...(await tursoShardManager.getAllShards("project", "")),
  ];

  let scanned = 0;
  let pairs = 0;
  let flagged = 0;
  const samples: ConflictSample[] = [];

  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoShardManager.ensureShardSchema(db);
    const rows = await db.all(
      `SELECT id, content, container_tag FROM memories
       WHERE aged_at IS NULL AND compacted_into IS NULL`
    );
    const docs: Document[] = rows.map((row) => {
      const content = String(row.content ?? "");
      return {
        id: String(row.id),
        tag: String(row.container_tag ?? ""),
        content,
        tokens: tokenize(content),
        numbers: extractNumbers(content),
        negated: negatedTerms(content),
      };
    });
    scanned += docs.length;

    // The candidates come from an inverted index: two records can only
    // contradict each other if they share words, and comparing every pair of
    // fifteen hundred records against each other is work nobody needs.
    const postings = new Map<string, number[]>();
    docs.forEach((doc, index) => {
      for (const token of doc.tokens) {
        const list = postings.get(token);
        if (list) list.push(index);
        else postings.set(token, [index]);
      }
    });

    for (let i = 0; i < docs.length; i++) {
      if (flagged >= limit) break;
      const a = docs[i]!;
      if (a.tokens.size === 0) continue;
      const shared = new Map<number, number>();
      for (const token of a.tokens) {
        for (const index of postings.get(token)!) {
          if (index <= i) continue;
          shared.set(index, (shared.get(index) ?? 0) + 1);
        }
      }
      for (const [index, count] of shared) {
        if (flagged >= limit) break;
        if (count < 2) continue;
        const b = docs[index]!;
        if (a.tag !== b.tag) continue;
        const conflict = detectConflict(a, b);
        if (!conflict) continue;
        pairs += 1;
        const [first, second] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        if (!dryRun) {
          await db.run(
            `INSERT OR REPLACE INTO memory_conflicts
             (id, memory_id, other_id, kind, confidence, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              `${first}:${second}`,
              first,
              second,
              conflict.kind,
              conflict.confidence,
              conflict.reason,
              Date.now(),
            ]
          );
        }
        flagged += 1;
        if (samples.length < 10) {
          samples.push({
            memoryId: first,
            otherId: second,
            kind: conflict.kind,
            confidence: Number(conflict.confidence.toFixed(3)),
            reason: conflict.reason,
          });
        }
      }
    }
  }

  log("Contradiction scan", { dryRun, scanned, pairs, flagged });
  return { dryRun, scanned, pairs, flagged, samples };
}

export type ProfileCleanReport = {
  dryRun: boolean;
  profiles: number;
  removed: number;
  restored: number;
  items: Array<{ profileId: string; kind: string; description: string }>;
};

/** The kind of the profile lists that carry a claim. */
const PROFILE_KINDS = ["preferences", "patterns", "workflows"] as const;

/** The summary the cleaning writes, and the marker of its own changelogs. */
const SWEEP_SUMMARY = "Sweep: the records that supported the item were forgotten";

/**
 * Forget the profile items whose support was forgotten.
 *
 * The profile is a derivate of the records, so a record that the sweep put
 * away takes its profile item with it - but only when no live record still
 * supports the item. An item that another record backs stays, and an item that
 * no forgotten record ever matched stays as well: it was learned from the
 * prompts and the store never held it.
 *
 * The cleaning is idempotent and reversible: the items it removed are in the
 * profile's changelog, so they are candidates again, and a record that came
 * back brings its item back with it.
 */
export async function forgetUnsupportedProfileItems(
  options: { dryRun?: boolean } = {}
): Promise<ProfileCleanReport> {
  const dryRun = options.dryRun !== false;

  await ensureTursoReady();
  const shards = [
    ...(await tursoShardManager.getAllShards("user", "")),
    ...(await tursoShardManager.getAllShards("project", "")),
  ];

  const forgotten: Array<Set<string>> = [];
  const live: Array<Set<string>> = [];
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoShardManager.ensureShardSchema(db);
    const aged = await db.all(`SELECT content FROM memories WHERE aged_at IS NOT NULL`);
    for (const row of aged) forgotten.push(tokenize(String(row.content ?? "")));
    const current = await db.all(
      `SELECT content FROM memories WHERE aged_at IS NULL AND compacted_into IS NULL`
    );
    for (const row of current) live.push(tokenize(String(row.content ?? "")));
  }

  const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
  const profiles = await userProfileManager.getAllActiveProfiles();
  let removed = 0;
  let restored = 0;
  const items: Array<{ profileId: string; kind: string; description: string }> = [];

  for (const profile of profiles) {
    const data = JSON.parse(profile.profileData) as UserProfileData;

    // The items a previous cleaning removed are in the changelog: the snapshot
    // before the removal. They are candidates again.
    const extra = new Map<string, any>();
    const changelogs = await userProfileManager.getProfileChangelogs(profile.id, 10);
    for (const changelog of changelogs) {
      if (String(changelog.changeSummary ?? "").startsWith("Sweep:")) continue;
      let snapshot: UserProfileData;
      try {
        snapshot = JSON.parse(changelog.profileDataSnapshot) as UserProfileData;
      } catch {
        continue;
      }
      for (const kind of PROFILE_KINDS) {
        for (const item of snapshot[kind] ?? []) {
          extra.set(`${kind}:${item.description ?? ""}`, item);
        }
      }
      break;
    }

    const decide = (item: any): boolean => {
      const tokens = tokenize(String(item.description ?? ""));
      if (tokens.size === 0) return false;
      const wasForgotten = forgotten.some((other) => jaccard(tokens, other) >= 0.5);
      const stillSupported = live.some((other) => jaccard(tokens, other) >= 0.5);
      return wasForgotten && !stillSupported;
    };

    let changed = false;
    for (const kind of PROFILE_KINDS) {
      const list = (data[kind] ?? []) as any[];
      const kept: any[] = [];
      const present = new Set<string>();
      for (const item of list) {
        const key = `${kind}:${item.description ?? ""}`;
        present.add(key);
        if (decide(item)) {
          removed += 1;
          items.push({ profileId: profile.id, kind, description: item.description ?? "" });
          changed = true;
          continue;
        }
        kept.push(item);
      }
      for (const [key, item] of extra) {
        if (!key.startsWith(`${kind}:`) || present.has(key)) continue;
        if (decide(item)) continue;
        kept.push(item);
        restored += 1;
        changed = true;
      }
      data[kind] = kept as never;
    }

    if (changed && !dryRun) {
      await userProfileManager.updateProfile(profile.id, data, 0, SWEEP_SUMMARY);
    }
  }

  log("Profile cleaning", { dryRun, profiles: profiles.length, removed, restored });
  return { dryRun, profiles: profiles.length, removed, restored, items };
}
