# MiaoTV

[简体中文](README.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG)

<div align="center"><img src="public/logo.png" alt="MiaoTV" width="120"></div>

MiaoTV is a self-hosted video search and playback app based on MoonTV and LunaTV. Connect video sources, live channels, or an Emby library to search, play, save favorites, and resume watching in your browser.

The project does not host video content. The person running the instance configures on-demand sources; features such as short-drama listings and danmaku call third-party services. Use content you are allowed to access.

## Features

- Search multiple sources and browse Douban, Bangumi, and short-drama listings.
- Play on-demand video and live channels, switch sources and episodes, display danmaku, and skip intros or credits.
- Save favorites, viewing history, and a watchlist. A server-side database enables synchronization across devices.
- Manage users, invitation codes, and registration approval; configure email, password recovery, and OIDC login.
- Connect Emby, TVBox, and compatible clients; enable video downloads and WebSR upscaling when needed.

Emby and WebSR are disabled by default; enable them in the [site configuration](docs/deployment/CONFIGURATION.md#emby-和-websr-开关). WebSR requires WebGPU. Availability also depends on media sources, third-party services, and client support. Most detailed guides are currently in Chinese.

## Run with Docker

Install Docker and Docker Compose. The included [compose.yaml](compose.yaml) builds MiaoTV from source and starts Redis with persistent storage. The current build target is `linux/amd64`.

```sh
git clone https://github.com/bytedo/miaotv.git
cd miaotv
cp .env.example .env.local
```

On Windows PowerShell, use `Copy-Item .env.example .env.local`. Edit `.env.local` and set the owner account's `USERNAME` and `PASSWORD`. There is no default password; choose a long, unique one before starting the service.

```sh
docker compose up -d --build
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), sign in, and add your video sources in the admin panel. Registration is enabled for a new database. Review registration, approval, and invitation settings before making the site public.

Compose binds the app to the local machine and does not expose Redis. For remote access, change the app's port binding or configure a reverse proxy with a domain and HTTPS. Redis data lives in the `redis-data` volume; deleting that volume deletes accounts, settings, and viewing history. Back up the database before upgrading.

The public GHCR image needs a successful publishing run by a maintainer before it can be pulled. Use the source build above for an initial installation. See the [deployment guide](docs/deployment/DEPLOYMENT.md) for existing databases, image publishing, and platform templates.

## Local development

Use Node.js 22.23.2 from [.nvmrc](.nvmrc) and pnpm 10.14.0. Clone the repository and prepare `.env.local`, then run:

```sh
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm dev:local
```

`pnpm dev:local` listens on `127.0.0.1:3000` and reads the owner username from the project's environment files, avoiding a conflict with Windows' system `USERNAME`. Use `pnpm dev:local --port 3001` to change the port. For LAN testing, `pnpm dev` listens on `0.0.0.0` and follows normal process environment precedence.

[.env.example](.env.example) uses browser local storage by default, which is enough to try the interface and playback. Registration, persistent admin settings, and cross-device synchronization require Redis, Kvrocks, Upstash, or SQLite. SQLite does not support invitation codes. Compose sets up Redis; for local development, choose a backend using the [configuration guide](docs/deployment/CONFIGURATION.md).

Before submitting code changes, run:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests use Node.js's built-in test runner. See [CONTRIBUTING.md](CONTRIBUTING.md) for the directory layout, Redis/Lua test dependencies, and contribution guidelines.

## Documentation and support

| Task                                                | Guide                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Deploy, upgrade, or back up an instance             | [Deployment](docs/deployment/DEPLOYMENT.md)                              |
| Configure storage, registration, email, or features | [Configuration](docs/deployment/CONFIGURATION.md)                        |
| Connect Emby, TVBox, or mobile clients              | [Clients and media libraries](docs/README.md#客户端与媒体库)             |
| Configure third-party login                         | [OIDC setup and provider limitations](docs/authentication/OIDC_SETUP.md) |
| Troubleshoot media and third-party connections      | [Proxy configuration](docs/advanced/PROXY_CONFIG.md)                     |
| Review authentication and data handling             | [Security and privacy](docs/security/SECURITY.md)                        |
| Report a bug or contribute                          | [Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md)        |

Keep a native database backup and the previous image when upgrading. The admin panel's `.dat` export does not replace a full database backup.

## Attribution and license

MiaoTV builds on [LunaTV](https://github.com/SzeMeng76/LunaTV) and [MoonTV](https://github.com/MoonTechLab/LunaTV). It retains the [CC BY-NC-SA 4.0](LICENSE) license, which requires attribution, restricts use to noncommercial purposes, and requires adaptations to use the same license. The noncommercial restriction means this is not an OSI-approved open-source license.

© 2025–2026 LunaTV Enhanced Edition & Contributors. See [NOTICE.md](NOTICE.md) for source attribution, third-party components, and fonts. Public version changes are recorded in [CHANGELOG](CHANGELOG).
