import { AppError } from "../observability/errors";

export interface MessageSection {
  required: string;
  compact?: string;
  optional: string[];
  omissionMarker?: string;
  detailsOmitted?: boolean;
}
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

export function assembleBlocks(sections: readonly MessageSection[], maxLength: number): string {
  const limit = Math.min(2000, maxLength);
  const required = sections.map((section) => section.required);
  const admitted = sections.map((): string[] => []);
  const marker = "[部分明细已省略]";
  const compacted = new Set<number>();
  const render = () => {
    let globalOmitted = false;
    const paragraphs: string[] = [];
    for (const [index, section] of sections.entries()) {
      const items = admitted[index] ?? [];
      const omitted = compacted.has(index) || section.detailsOmitted === true || items.length < section.optional.length;
      if (omitted && section.omissionMarker === undefined) globalOmitted = true;
      paragraphs.push([required[index], ...items, ...(omitted && section.omissionMarker !== undefined ? [section.omissionMarker] : [])].filter(Boolean).join("\n"));
    }
    return paragraphs.join("\n") + (globalOmitted ? `\n${marker}` : "");
  };
  const replacements = sections.map((section, index) => ({ section, index, saving: byteLength(section.required) - byteLength(section.compact ?? section.required) })).sort((a, b) => b.saving - a.saving);
  for (const { section, index, saving } of replacements) {
    if (byteLength(render()) <= limit) break;
    if (saving > 0 && section.compact !== undefined) { required[index] = section.compact; compacted.add(index); }
  }
  if (!Number.isFinite(limit) || byteLength(render()) > limit) throw new AppError("notification_content_unrepresentable", "Notification cannot preserve required information", false);
  const activeSections = sections.filter((section) => section.optional.length > 0).length;
  const share = Math.floor((limit - byteLength(render())) / Math.max(1, activeSections));
  const pending: { index: number; text: string }[] = [];
  for (let rank = 0; rank < Math.max(0, ...sections.map((section) => section.optional.length)); rank++) {
    sections.forEach((section, index) => {
      const text = section.optional[rank];
      if (text !== undefined) pending.push({ index, text });
    });
  }
  const accepted = new Set<number>();
  for (const fair of [true, false]) for (const [candidateIndex, candidate] of pending.entries()) {
    if (accepted.has(candidateIndex)) continue;
    const list = admitted[candidate.index];
    if (list === undefined) continue;
    if (fair && byteLength([...list, candidate.text].join("\n")) > share) continue;
    list.push(candidate.text);
    if (byteLength(render()) <= limit) accepted.add(candidateIndex);
    else list.pop();
  }
  admitted.forEach((items, index) => {
    const original = sections[index]?.optional ?? [];
    items.sort((left, right) => original.indexOf(left) - original.indexOf(right));
  });
  return render();
}
