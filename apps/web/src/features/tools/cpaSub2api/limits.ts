export const MAX_FILES_PER_IMPORT = 100;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

export interface ImportCandidate {
  name: string;
  size: number;
  json: boolean;
}

export interface ImportRejection {
  name: string;
  code: 'notJson' | 'tooLarge' | 'tooMany' | 'totalTooLarge';
}

export function validateImportCandidates(candidates: ImportCandidate[]) {
  const accepted: number[] = [];
  const rejected: ImportRejection[] = [];
  let acceptedBytes = 0;

  candidates.forEach((candidate, index) => {
    if (index >= MAX_FILES_PER_IMPORT) {
      rejected.push({ name: candidate.name, code: 'tooMany' });
      return;
    }
    if (!candidate.json) {
      rejected.push({ name: candidate.name, code: 'notJson' });
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      rejected.push({ name: candidate.name, code: 'tooLarge' });
      return;
    }
    if (acceptedBytes + candidate.size > MAX_TOTAL_BYTES) {
      rejected.push({ name: candidate.name, code: 'totalTooLarge' });
      return;
    }
    acceptedBytes += candidate.size;
    accepted.push(index);
  });

  return { accepted, rejected, acceptedBytes };
}

export function exceedsPasteLimit(text: string) {
  return new Blob([text]).size > MAX_PASTE_BYTES;
}
