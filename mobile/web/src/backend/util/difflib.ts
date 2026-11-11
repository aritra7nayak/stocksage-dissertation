/**
 * difflib.SequenceMatcher(None, a, b).ratio() — a faithful port (including
 * the autojunk "popular element" rule for b of length >= 200) so symbol
 * matching and merge suggestions score exactly like the server.
 */
export function ratio(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la + lb === 0) return 1;
  return (2 * matchingTotal(a, b)) / (la + lb);
}

function matchingTotal(a: string, b: string): number {
  const n = b.length;
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const ch = b[i];
    const list = b2j.get(ch);
    if (list) list.push(i);
    else b2j.set(ch, [i]);
  }
  const popular = new Set<string>();
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [ch, idxs] of b2j) if (idxs.length > ntest) popular.add(ch);
    for (const ch of popular) b2j.delete(ch);
  }

  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1; bestj = j - k + 1; bestsize = k;
        }
      }
      j2len = next;
    }
    // No isjunk function, so only "popular" elements count as junk-like here:
    // extend through equal non-popular elements first, then popular ones.
    while (besti > alo && bestj > blo && !popular.has(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && !popular.has(b[bestj + bestsize]) &&
           a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    while (besti > alo && bestj > blo && popular.has(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && popular.has(b[bestj + bestsize]) &&
           a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };

  let total = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, n]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}
