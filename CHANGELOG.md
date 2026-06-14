# Changelog

## [0.3.11](https://github.com/pro-vi/designer/compare/v0.3.10...v0.3.11) (2026-06-13)


### Features

* add network run-state observer ([#58](https://github.com/pro-vi/designer/issues/58)) ([8a3d3f1](https://github.com/pro-vi/designer/commit/8a3d3f149520e4b7ba5b529bc8fcc6b2321501a6))

## [0.3.10](https://github.com/pro-vi/designer/compare/v0.3.9...v0.3.10) (2026-06-11)


### Features

* **health:** assert composer is fillable, not just present ([#57](https://github.com/pro-vi/designer/issues/57)) ([5b7527e](https://github.com/pro-vi/designer/commit/5b7527ed5a1e60c8751445de428e24e99b3be096))


### Bug Fixes

* **setup:** detect sign-in on fresh Chrome profiles ([#32](https://github.com/pro-vi/designer/issues/32)) ([#55](https://github.com/pro-vi/designer/issues/55)) ([428a014](https://github.com/pro-vi/designer/commit/428a0149d5768aec27c53e8829daf26998d355b5))

## [0.3.9](https://github.com/pro-vi/designer/compare/v0.3.8...v0.3.9) (2026-06-10)


### Features

* **platform:** add Windows support — paths, spawn shims, Chrome launcher ([#2](https://github.com/pro-vi/designer/issues/2)) ([ad40bf2](https://github.com/pro-vi/designer/commit/ad40bf27ffe91392b94a57abad5f5532ca430717))


### Bug Fixes

* **cli:** print package version for --version/-v/version ([#46](https://github.com/pro-vi/designer/issues/46)) ([1606d84](https://github.com/pro-vi/designer/commit/1606d84d82cde71a91d0dbbd163f8c11640b41a3))

## [0.3.8](https://github.com/pro-vi/designer/compare/v0.3.7...v0.3.8) (2026-06-10)


### Bug Fixes

* **drift:** track 2026-06 claude.ai/design layout ([#50](https://github.com/pro-vi/designer/issues/50)) ([45ff5a2](https://github.com/pro-vi/designer/commit/45ff5a2e6ad939835fbce439b6aa706d821c1271)), closes [#49](https://github.com/pro-vi/designer/issues/49)

## [0.3.7](https://github.com/pro-vi/designer/compare/v0.3.6...v0.3.7) (2026-05-24)


### Features

* **auto-heal:** LLM-in-the-loop selector recovery on probe failure ([#19](https://github.com/pro-vi/designer/issues/19)) ([07ee9af](https://github.com/pro-vi/designer/commit/07ee9afb9d00caaa00e3ee6eb4482e91fef8a534))
* **browser:** add tabs() and activateTab() primitives ([0fb8093](https://github.com/pro-vi/designer/commit/0fb8093a78b674471a0c02d7f8e07779a39f654c))
* **ci:** add daily-health cron, release-please, dependabot auto-loop ([c83ac9a](https://github.com/pro-vi/designer/commit/c83ac9ae914f0fe3743026b7314fbcd4ddb4dc1f))
* **cli:** accept stdin (-) and --prompt-file for prompt/ask ([7ade62d](https://github.com/pro-vi/designer/commit/7ade62ddeb5fd35dfa67e404881ed4b37e31f36a))
* **cli:** grouped help + per-verb --help + stop advertising legacy aliases ([1c9a229](https://github.com/pro-vi/designer/commit/1c9a2290029464409a0279c2d06a9f381522049f))
* designer doctor + designer-chrome.sh launcher ([3aec9d8](https://github.com/pro-vi/designer/commit/3aec9d8b5ac418137920895e0bf65200b324361f))
* designer health — enumerate + probe every UI anchor we depend on ([e0420c0](https://github.com/pro-vi/designer/commit/e0420c07040b29d7b76c220ecb89c345ca3bae0b))
* **dx:** bin/designer wrappers + npm-script shortcuts ([3fbc2fd](https://github.com/pro-vi/designer/commit/3fbc2fd03952c7b9bd46e2502e425064f137c0a7))
* **health:** add file-list scrape probe ([5482800](https://github.com/pro-vi/designer/commit/5482800679fa84f64d40dabe204f6dc72f50f781))
* **health:** probe a canary project for session-state anchor coverage ([ad5afd1](https://github.com/pro-vi/designer/commit/ad5afd1235cdfcdd69cc770d95481235f45a5be6))
* **health:** two-phase home+session probe with adaptive wait ([#18](https://github.com/pro-vi/designer/issues/18)) ([700f3d1](https://github.com/pro-vi/designer/commit/700f3d172e607c1caca1d329a3e18a0db63305cd))
* **iterate:** raise default timeout 10m -&gt; 20m for hi-fi runs ([42783fd](https://github.com/pro-vi/designer/commit/42783fd27a5e2118566e9f863cf05f652269f2ee))
* **listFiles:** detect folders, report honestly, point at handoff ([66fb654](https://github.com/pro-vi/designer/commit/66fb65424010b4f72b8709bf1061aec4f34e4360))
* **prompt:** add --decisive suffix and awaitingClarification status signal ([8beb648](https://github.com/pro-vi/designer/commit/8beb648f2987a3efa637546b29142f0634e2d377))
* **prompt:** auto-append flat-layout suffix to every designer_prompt ([03421b9](https://github.com/pro-vi/designer/commit/03421b9ac663d90518f55757dcb32e9ec2346b64))
* **setup:** one-call onboarding (designer setup) ([2ba6701](https://github.com/pro-vi/designer/commit/2ba6701c069088e247a499a290e5f04c253073a6))


### Bug Fixes

* **anchors:** replace chatTurnPrefix text-prefix check with data-index API ([#24](https://github.com/pro-vi/designer/issues/24)) ([e7781ef](https://github.com/pro-vi/designer/commit/e7781ef8132c6c428b082caf4b2b1ccf2550f574))
* **auto-heal:** security + silent-failure hardening from second-opinion review ([#21](https://github.com/pro-vi/designer/issues/21)) ([f959d7b](https://github.com/pro-vi/designer/commit/f959d7b3e681ef1a0eefc9e91ffa16bd227fea6a))
* **browser:** default DESIGNER_CDP to 9222 so shell callers attach to the live Chrome ([6db4052](https://github.com/pro-vi/designer/commit/6db4052410a04e2afd25afa2b82f11f1976c17a2))
* **ci:** capture tar output to file to avoid pipefail SIGPIPE ([d877046](https://github.com/pro-vi/designer/commit/d877046e577ef2d9cb5b1bd299b03630f605696a))
* **ci:** gate dependabot-automerge on completed CI run ([bbc4375](https://github.com/pro-vi/designer/commit/bbc4375974eaf938679b9f89a1f20637d761f9ec))
* **ci:** grouped-PR automerge + auto-close stale drift PRs on green ([1af0494](https://github.com/pro-vi/designer/commit/1af0494bfed65b56b035e91a1910e57ba2775dc6))
* **ci:** tighten the auto-loop after second-opinion review ([b98a91f](https://github.com/pro-vi/designer/commit/b98a91f50dbb34299a662f6821b14324d010ba57))
* **ci:** use prepack hook so npm pack rebuilds dist/ ([658b78a](https://github.com/pro-vi/designer/commit/658b78a50b305f76fd61f11372bf0f1632880a9b))
* **doctor,health:** split misleading labels; gate iframe probes on file-open ([c974572](https://github.com/pro-vi/designer/commit/c974572d5b293b85a57cb995a5a1f8b654e2ab1c))
* **ensure_ready:** pick the live project tab among multiple matches ([3097af0](https://github.com/pro-vi/designer/commit/3097af0f8940c897b6777d7c916ad6a02ccfc80e))
* **handoff:** Export moved under Share dropdown; try Share first ([e944e21](https://github.com/pro-vi/designer/commit/e944e2175a0a51c182995e3dcc6d7096ad0490f7))
* **listFiles:** authoritative=false when rail is empty under visible 'Design Files' label ([268c2fb](https://github.com/pro-vi/designer/commit/268c2fb0e5d7691a931a7a8054cbb91a7970b977))
* **listFiles:** tree-walk text nodes (claude moved filenames from &lt;span&gt; to styled &lt;div&gt;) ([023d7c5](https://github.com/pro-vi/designer/commit/023d7c5930ea515a317fafc5566bfd596ae4ef85))
* **postinstall:** move to standalone file; fix shell quoting bug ([d79269f](https://github.com/pro-vi/designer/commit/d79269fdd3a787b10c92019d834a578d9c9a5690))
* **setup,doctor:** trust installed-mode (npx/bunx/pnpm don't put node_modules in pkg dir) ([4ae41b4](https://github.com/pro-vi/designer/commit/4ae41b4822a4c707cb0fee2279a72b7f872c0d6a))
* **setup:** handle installed-mode (no package-lock in shipped tarball) ([dd46b40](https://github.com/pro-vi/designer/commit/dd46b4017102529cdbe07f9b1f7e6d34ec00a12c))
* **setup:** register MCP at user scope so it's available in every project, not just this repo ([1459ab2](https://github.com/pro-vi/designer/commit/1459ab2566af67d4e8dc9d208570b6d805c8db96))
* **setup:** verify signed-in via DOM marker, not URL substring ([#22](https://github.com/pro-vi/designer/issues/22)) ([f7a27ec](https://github.com/pro-vi/designer/commit/f7a27ecd20d327c769910d3b351c2aecb8f6bb00))
* **tasting:** keyboard 1/2/3 work when focus is inside the iframe ([640640c](https://github.com/pro-vi/designer/commit/640640cf41cbfb01bc5e8e62950b42a006865e9c))
* **types:** eliminate two /casting findings ([e9a341a](https://github.com/pro-vi/designer/commit/e9a341a83ca63aa9c2cd5a744ac84a234f7b9b57))
* **v0.3.7:** pre-release hardening pass from final /code-review ([#29](https://github.com/pro-vi/designer/issues/29)) ([2ed3e67](https://github.com/pro-vi/designer/commit/2ed3e6761ed66c1952ab882176d7e6c0f17301a7))
* **workflows:** add /opt/homebrew/bin to PATH on self-hosted runner ([#25](https://github.com/pro-vi/designer/issues/25)) ([e8f492f](https://github.com/pro-vi/designer/commit/e8f492fb74056f2ec47aa7880f6e83fd6908c42f))
