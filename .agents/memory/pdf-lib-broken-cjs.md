---
name: pdf-lib broken cjs build in this repl
description: How to import PDFDocument from pdf-lib here without ESM/CJS errors
---

In this project, `pdf-lib@1.17.1`'s installed `cjs/` build is incomplete — `cjs/index.js` is a 7-line stub that `require("./api/index")`, but `cjs/api/` was never extracted, so any normal import fails.

**Rule:** import pdf-lib via the self-contained UMD bundle, not the package entry:
```ts
import { createRequire } from "module";
const { PDFDocument } = createRequire(import.meta.url)("pdf-lib/dist/pdf-lib.js");
```

**Why:** Node ESM `import { PDFDocument } from 'pdf-lib'` → "no export named PDFDocument" (cjs-module-lexer can't read it). Default/namespace import → the cjs stub's broken `require('./api/index')` throws MODULE_NOT_FOUND. The `dist/pdf-lib.js` (and `.esm.js`) bundles are complete and standalone; the `.esm.js` one is still treated as CJS by Node (no `type:module`), so use the UMD `dist/pdf-lib.js` via createRequire.

**How to apply:** if a pdf-lib upgrade changes `dist/` filenames, re-check `node_modules/pdf-lib/dist/` for the standalone bundle.
