# Remote (unattended) checks

`tracker-check.mjs` reads the tracker's Firestore data without a browser, so a
scheduled Claude routine can run it while nobody is at a desk and push a short
list of what needs a human.

It is **read-only**. It never writes to Firestore and never touches the customs
portal.

```
node tools/tracker-check.mjs            # markdown report
node tools/tracker-check.mjs --json     # same findings as JSON
node tools/tracker-check.mjs --quiet    # silent when there is nothing to report

node --test tools/tracker-check.test.mjs
```

## What it reports

| Check | Why it matters |
| --- | --- |
| **Missing R number** | Delivered / Cleared / already billed, but `R NO` is blank — the rows the `r-number-filler` skill should be pointed at |
| **Missing R number, no AWB** | Same, but there is no AWB / BL to look up, so somebody has to enter that first |
| **Duplicate AWB / BL** | The same shipment entered twice, normalised past the portal's stray spaces and dashes — a double-billing risk |
| **Delivered but no BILL NO** | Saving a BILL NO is what sets a row to Delivered, so a Delivered row without one means the invoice was never recorded |
| **Unread customer messages** | Messages left on `status.html` that nobody has opened |

Billing-only rows (STELCO sea, `BILL` serials) are excluded from the R-number
checks — they clear without documentation and never get an R number.

## Setup

### 1. Create a Firebase service account

Firebase console → project **lion-tracker-47830** → ⚙ **Project settings** →
**Service accounts** → **Generate new private key**. That downloads a JSON file.

Give it the **Cloud Datastore Viewer** role (IAM → the new
`...iam.gserviceaccount.com` principal → Edit → add role). Viewer is enough:
this script only reads, and a viewer-only key cannot damage the tracker even if
it leaks.

> A service-account key bypasses Firestore security rules, which is why the
> read-only role matters.

### 2. Put the key in the environment

At [claude.ai/code](https://claude.ai/code), click the cloud icon in the row
above the message box → hover the environment → the settings gear →
**Environment variables**. Add one line, the whole JSON on that line:

```
LION_FB_SA={"type":"service_account","project_id":"lion-tracker-47830",...}
```

If pasting raw JSON is awkward, base64 it first (`base64 -w0 key.json`) and
paste that instead — the script accepts raw JSON, base64, or a file path.

Sessions read environment variables once at startup, so the next routine run
picks it up; a session already running does not.

> Cloud environments have no secrets store — anything you put here is readable
> by anyone who uses the environment. Personal environments are only yours, and
> a Datastore-Viewer key is about as low-stakes as a credential gets, but that
> is the trade being made.

### 3. Check it

Ask a session to run `node tools/tracker-check.mjs`. Until the variable is set
it exits 1 with `No credentials` — that is the expected "not configured yet"
state, and the routine treats it as a no-op rather than an alert.

## Network access

The script works on the **Trusted** network level with no changes:
`*.googleapis.com` is already on the default allowlist, which covers
`oauth2.googleapis.com` and `firestore.googleapis.com`.

These are **not** reachable on Trusted, and are blocked today:

- `portal.customs.gov.mv`
- `jamez3556.github.io` (the tracker page itself)
- `lion-qb-sync.vercel.app`

To allow them: same environment dialog → **Network access** → **Custom** → list
them one per line in **Allowed domains**, and tick **Also include default list
of common package managers** so package installs and `*.googleapis.com` keep
working.

### Why that still will not automate the R-number lookup

Reaching the portal is only the first of two blockers. The second is
authentication: the `r-number-filler` skill's login route works by opening
`customs.gov.mv` → **Customs Portal**, which picks up an existing **eFaas**
session from Jaamiz's own signed-in Chrome. A cloud session has no browser and
no eFaas session to inherit, and eFaas is interactive sign-in, which cloud
sessions do not support.

So the split stands: this script finds *which* shipments need an R number
unattended, and the browser skill fills them in.
