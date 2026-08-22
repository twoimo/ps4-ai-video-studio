const FILE_PATH = /(?:file:\/\/\S+)|(?:[A-Za-z]:\\(?:[\w.+-]+\\)+[\w.+-]+)|(?:(?:^|[\s"'`(=])(?:\/(?:workspace|opt|usr|home|Users|tmp|var|private|root)(?:\/[\w.+-]+)+))|(?:(?:^|[\s"'`(=])(?:workspace|resource)\/[\w./+-]+)/g;

export function stripPublicPaths(value) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(stripPublicPaths);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripPublicPaths(item)]));
  }
  return String(value).replace(FILE_PATH, (match) => {
    const lead = match.match(/^[\s"'`(=]/);
    return lead ? lead[0] : "";
  }).replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}
