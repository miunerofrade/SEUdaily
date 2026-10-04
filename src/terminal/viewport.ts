/** Keep the viewport still until the selected item crosses its visible edge. */
export function followSelection(top: number, selected: number, capacity: number, total: number): number {
  const size = Math.max(1, capacity);
  const current = Math.max(0, Math.min(Math.max(0, total - size), top));
  return Math.max(0, Math.min(Math.max(0, total - size),
    selected < current ? selected : selected >= current + size ? selected - size + 1 : current));
}
