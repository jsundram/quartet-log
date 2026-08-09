// Ambient declarations for build-time constants injected by esbuild --define
// (see build.sh). Code must keep the `typeof __WORKS_VERSION__` guard —
// under plain Node (tests) nothing defines the constant at runtime.
declare const __WORKS_VERSION__: string;
