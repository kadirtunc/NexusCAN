// Vite `?raw` imports (file contents as a string), e.g. the bundled CHANGELOG.md.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
