# Third-party references

## genshin-db metadata snapshot

`packages/gacha-core/src/catalog/genshin-items.json` is extracted from
[`theBowja/genshin-db`](https://github.com/theBowja/genshin-db), npm version
`5.2.14`. It contains factual item IDs, types, rarities and names, without images,
descriptions, character statistics or game assets. The exact source version is
pinned in the package manifest and lockfile.

Copyright (c) 2020 theBowja. The complete MIT notice is distributed in
[`packages/gacha-core/METADATA_LICENSE`](packages/gacha-core/METADATA_LICENSE).
Genshin Impact and its game content belong to their respective owners. This
project is not affiliated with miHoYo.

## Apache ECharts and ZRender

The statistics page uses [Apache ECharts 6.1.0](https://echarts.apache.org/)
(Apache-2.0) and its ZRender 6.1.0 dependency (BSD-3-Clause).
The npm packages' license and notice texts are retained in
`apps/web/public/licenses/` and copied into the built web distribution:

- [ECharts license](apps/web/public/licenses/echarts-LICENSE.txt)
- [ECharts notice](apps/web/public/licenses/echarts-NOTICE.txt)
- [ZRender license](apps/web/public/licenses/zrender-LICENSE.txt)

## QR Code browser encoder

The Miyoushe account page uses [node-qrcode 1.5.4](https://github.com/soldair/node-qrcode)
and its DijkstraJS 1.0.3 dependency to encode QR images locally in the browser.
Both use the MIT License. Their complete notices are distributed with the web build:

- [node-qrcode license](apps/web/public/licenses/qrcode-LICENSE.txt)
- [DijkstraJS license](apps/web/public/licenses/dijkstrajs-LICENSE.txt)

## UIGF JSON Schemas

The versioned JSON Schemas in `packages/uigf/src/schemas/` were extracted from
[UIGF-org/UIGF-org.github.io](https://github.com/UIGF-org/UIGF-org.github.io), commit
`0bba3809236602d4ada66a84a17de4e0ab89d170`, under the MIT License:

- `docs/zh/standards/uigf-legacy-v4.0.md`
- `docs/zh/standards/uigf-legacy-v4.1.md`
- `docs/zh/standards/uigf.md` (v4.2)

Copyright (c) 2022 Masterain. The complete license is reproduced in
[packages/uigf/SCHEMA_LICENSE](packages/uigf/SCHEMA_LICENSE).
Only formatting has changed; the complete upstream schemas are retained.

## TeyvatGuide

The Miyoushe provider implements protocol behavior and parameters researched from
[BTMuli/TeyvatGuide](https://github.com/BTMuli/TeyvatGuide), commit
`72c3f371673e40cf0c2153535ddddafd24462fbc`, especially:

- `src/request/passportReq.ts`
- `src/request/takumiReq.ts`
- `src/request/hk4eReq.ts`
- `src/request/lunaReq.ts` (R18 game check-in activities and protocol behavior)
- `src/utils/network/getRequestHeader.ts`
- `src/utils/bbs/TGBbs.ts`

Its MIT notice is reproduced here. This application is not affiliated with miHoYo,
HoYoLAB, or TeyvatGuide. Endpoint availability requires independent validation.

```text
The MIT License (MIT)

Copyright (C) 2023-present BTMuli<bt-muli@outlook.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
