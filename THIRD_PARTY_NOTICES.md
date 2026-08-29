# Third-Party Notices

Last reviewed for `0.4.0` on 2026-08-29.

The published package does not vendor `node_modules`, third-party binaries, or
third-party Skill source. Its compiled JavaScript imports the direct runtime
dependency below, declares the OpenCode plugin API as a peer dependency, and
installs a pinned external Superpowers reference into the target project's
OpenCode configuration. Those relationships and their upstream notices are
recorded here.

## jsonc-parser 3.3.1

- Relationship: direct runtime dependency installed separately by npm; its
  source is not bundled into this package tarball.
- Source: <https://github.com/microsoft/node-jsonc-parser/tree/v3.3.1>
- License: MIT
- Copyright: Microsoft

```text
The MIT License (MIT)

Copyright (c) Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @opencode-ai/plugin

- Relationship: peer dependency `>=1.14.22 <1.16.0` and development API
  baseline `1.14.22`; it is not bundled into this package tarball.
- Source: <https://github.com/anomalyco/opencode>
- License: MIT
- Copyright: 2025 opencode

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Superpowers v6.2.0

- Relationship: external companion plugin pinned as
  `superpowers@git+https://github.com/obra/superpowers.git#v6.2.0`. The
  initializer writes only this reference; Superpowers files are fetched and
  managed by OpenCode and are not copied into this package tarball.
- Source: <https://github.com/obra/superpowers/tree/v6.2.0>
- License: MIT
- Copyright: 2025 Jesse Vincent

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development-only dependencies

The source repository also directly uses TypeScript `5.8.2` (Apache-2.0) and
`@types/node` `22.13.9` (MIT) to build and type-check the project. They and the
transitive development dependency tree are excluded from this package tarball;
their installed packages retain their own upstream license files.

Command-line programs required by an initialized Android project, including
Git, `jq`, ripgrep, Java, Gradle, and the Android SDK, are discovered on the
host. This package neither distributes nor installs those programs.
