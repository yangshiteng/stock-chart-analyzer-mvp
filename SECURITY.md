# Security Policy

## Security Posture

This repository is a public MVP prototype, not a production trading system.

Current security limitations:

- the Chrome extension stores the OpenAI API key in `chrome.storage.local`
- the extension sends screenshots and prompt context directly from the client to the OpenAI API
- there is no backend secret vault, user authentication layer, or server-side request mediation
- there is no formal hardening, penetration testing, or independent security review

Because of that, you should treat this project as suitable for local experimentation only.

## Safe Usage Guidance

- use a dedicated API key with minimal blast radius
- never commit API keys, tokens, cookies, or brokerage credentials
- do not assume screenshots, prompts, or model output are private beyond the configured API provider flow
- do not use this extension for unattended real-money trading
- review all extension permissions and code paths before loading a modified fork

## Reporting

If you discover a security issue in this repository, please avoid posting sensitive exploit details in a public issue.

Instead, contact the repository owner privately through GitHub and include:

- a short description of the issue
- steps to reproduce
- potential impact
- any suggested mitigation

## Supported Versions

This is an MVP repository with no formal release support policy yet.
Security fixes, if any, will generally target the latest code on `main`.
