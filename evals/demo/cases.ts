// Demo question groups (demo-plan mục 4) shared by evals/demo-system-one.ts
// and evals/demo-full.ts. Question text stays in the git-ignored CSV.

export const SUPPORTED_SITES = ['a', 'f', 'b'] as const;

interface DemoGroup {
  site: string;
  name: string;
  /** The input gate (a) must let the turn through. */
  mustPass: boolean;
  /** A tool question: tool skip (f) must leave the selector in place. */
  mustKeepSelector: boolean;
  stts: number[];
}

export const GROUPS: readonly DemoGroup[] = [
  {
    site: 'a',
    name: 'a-chặn',
    mustPass: false,
    mustKeepSelector: false,
    stts: [114, 116, 118, 119, 99, 105, 137, 1, 96, 125, 126],
  },
  {
    site: 'a',
    name: 'a-đi tiếp',
    mustPass: true,
    mustKeepSelector: false,
    stts: [2, 127, 135],
  },
  {
    site: 'f',
    name: 'f-bỏ chọn tool',
    mustPass: true,
    mustKeepSelector: false,
    // 14, 16, 22 from mục 4 plus the other step-2 probe document questions.
    stts: [14, 16, 22, 23, 37, 41, 75, 92, 17, 29],
  },
  {
    site: 'f',
    name: 'f-giữ chọn tool',
    mustPass: true,
    mustKeepSelector: true,
    stts: [34, 68, 132, 58],
  },
  {
    site: 'b',
    name: 'b-có số liệu',
    mustPass: true,
    mustKeepSelector: false,
    stts: [14, 16, 20, 22, 23, 75],
  },
];

export interface DemoCase {
  stt: number;
  group: string;
  mustPass: boolean;
  mustKeepSelector: boolean;
}

/** One case per STT: an STT in several groups (f and b share 14, 16, 22,
 *  23, 75) runs once, group names joined by `+`, expectations OR-ed. */
export function buildCases(sites: string[], onlyStt?: number[]): DemoCase[] {
  const byStt = new Map<number, DemoCase>();
  for (const group of GROUPS.filter((item) => sites.includes(item.site)))
    for (const stt of group.stts) {
      if (onlyStt && !onlyStt.includes(stt)) continue;
      const seen = byStt.get(stt);
      byStt.set(stt, {
        stt,
        group: seen ? `${seen.group}+${group.name}` : group.name,
        mustPass: (seen?.mustPass ?? false) || group.mustPass,
        mustKeepSelector:
          (seen?.mustKeepSelector ?? false) || group.mustKeepSelector,
      });
    }
  return [...byStt.values()];
}
