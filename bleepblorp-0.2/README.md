# bleepblorp 0.2 - Strategist member beta testing

Educational **paper** trading assistant for Kalshi 15-minute crypto Up/Down markets (BTC, ETH, SOL, XRP).

**This is not financial advice.** All trading involves risk, including loss of money. Paper results are not live results. The software does **not** place orders. You are solely responsible for anything you do with this code once you have it. No warranty.

## Windows (easiest)

1. Install [Node.js 20 LTS](https://nodejs.org) (includes npm). Close and reopen terminals.
2. Unzip so `START HERE.txt`, `package.json`, and `Start-bleepblorp.bat` are in the **same** folder.
3. Double-click `Start-bleepblorp.bat`.
4. When it says Ready, open http://localhost:3000

If `npm install` fails inside OneDrive or Desktop, unzip to `C:\bleepblorp-0.2` instead.

## Mac / Linux / PowerShell

```text
npm install
cp .env.example .env.local
npm run build
npm run start
```

Windows PowerShell can use `copy .env.example .env.local` instead of `cp`.

Then open http://localhost:3000

`.env.example` already sets `BLEEPBLORP_STANDALONE=1`. Add your own Kalshi API keys when you are ready (see **bleepblorp-0.2-manual.txt**, section 4).

## Read next

| File | What it is |
|------|------------|
| `START HERE.txt` | One-page launch |
| `Start-bleepblorp.bat` | Windows: install + build + run |
| `bleepblorp-0.2-manual.txt` | Install, troubleshooting, Kalshi API, DigitalOcean, features, strategies |
| `.env.example` | Template only — never email a filled `.env.local` |

## Optional remote host

`deploy/install-droplet.sh` plus `deploy/bleepblorp-02.home.service` are for **your** Ubuntu droplet. Keep the dashboard on `127.0.0.1` and view it through an SSH tunnel. Full steps: manual, section 5.

## Scripts

```text
npm run build        required once (Start-bleepblorp.bat does this)
npm run start        overnight / normal run
npm run dev          optional study mode (Turbopack)
npm run exit-opt     rebuild SL/TP Rec PnL helper
npm run session-opt  rebuild session sit-out helper
```
