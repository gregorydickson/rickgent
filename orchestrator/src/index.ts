// Deliberately narrow installed-package API. Fixture dependency injection is
// available only through the package-private test bridge, never from here.
export { handleFatal, main } from "./cli.js";
