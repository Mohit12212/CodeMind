export const newFile = (name, code, language = "python") => ({
  id: Math.random().toString(36).slice(2, 9),
  name,
  code,
  language,
  review: null,
  refactor: null,
  tests: null,
  explanation: null,
  reviewedCode: null,
});

export const langFromName = (name, fallback = "python") => {
  const n = name.toLowerCase();
  if (n.endsWith(".py")) return "python";
  if (n.endsWith(".ts") || n.endsWith(".tsx")) return "typescript";
  if (n.endsWith(".js") || n.endsWith(".jsx") || n.endsWith(".mjs")) return "javascript";
  if (n.endsWith(".go")) return "go";
  if (n.endsWith(".java")) return "java";
  if (n.endsWith(".cpp") || n.endsWith(".cc") || n.endsWith(".hpp")) return "cpp";
  if (n.endsWith(".c") || n.endsWith(".h")) return "c";
  return fallback;
};
