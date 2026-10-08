import formats from '../seudaily/document_formats.json' with { type: 'json' };
export const documentExtensions = new Set(Object.keys(formats));
export const documentMediaTypes: Record<string, string> = Object.fromEntries(
  Object.entries(formats).map(([extension, format]) => [extension, format.mediaType]),
);
