# Pie — Privacy Policy

Last updated: 2026-11-17
Extension version: 2.0.0
Contact: xiewkevo66@gmail.com

Pie is, by default, a BYOK (Bring Your Own Key) Chrome extension: it runs
entirely on your device and talks directly to the model provider whose key
you supply, with no Pie server in between. Pie also offers an **optional**
official subscription. If you choose it, some data passes through Pie's own
service — described in detail below. In **neither** mode does Pie collect
analytics, telemetry, or track you.

## What we never do

- We don't collect analytics, telemetry, or usage tracking of any kind.
- We don't sell or share your data with third parties for their own purposes.
- We don't track you across sites. Your browsing history (`chrome.history`) and
  bookmarks (`chrome.bookmarks`) are **optional permissions** that stay off
  unless you explicitly grant them for search, cleanup, or memory enrichment.
- We don't sync your data across devices unless you opt in to the official
  Pie Pro subscription and keep **Memory** enabled — BYOK users remain 100%
  local-only.
- We never send full web pages or tool outputs to Pie's servers in the
  background. Aside from **Report a problem** (which only sends when you click
  Send) and the **Deep Research** / **Memory** features inside the optional
  official subscription described below, conversations stay on your device.

## Reporting a problem (you choose, every time)

Each agent reply has a **Report a problem** button. It is the only feature
that sends conversation content to Pie's servers, and it is entirely opt-in:
nothing is sent unless you open it and click Send, every single time. There
is no background reporting, no crash uploader, and no sampling.

When you do send a report, it includes:

- your description of the problem (optional),
- the conversation it was sent from — your messages, the agent's replies, the
  tools it called with their arguments, and the results those tools returned.
  **Tool results include content read from the pages the agent visited**, so
  if the agent read a page with personal or confidential information on it,
  that text can be part of the report,
- the same environment details as any other feedback (extension version,
  browser user-agent, active provider, UI language),
- your account email, if you are signed in to the optional subscription.

Screenshots are not included — images are reduced to a `[image 800x600]`
placeholder. The report is capped at roughly 150 KB; longer conversations are
trimmed from the beginning.

The drawer states this before you send. If a conversation touched something
you would rather not share, don't report from it — send feedback from
Settings instead, which never attaches conversation content.

Reports are stored by Pie and used only to diagnose the problem you reported.
Contact us to have one deleted.

## What stays on your device

The following are stored only in a local IndexedDB database (named `pie`) on
the device where you installed Pie:

- **API keys** — encrypted with AES-GCM (Web Crypto API). The encryption key
  is generated locally and stored alongside the ciphertext. Pie never
  transmits your BYOK API key to anyone other than the model provider you
  configured.
- **Sessions** — your conversation history, pinned tab references, scheduled
  tasks, and skills you (or the agent) authored.
- **Preferences** — UI settings (theme, language, CDP keyboard toggle, etc.).

## What gets sent off-device, and to whom

### Bring your own key (BYOK) — the default

When you run a chat or an agent task with your own key, Pie sends data
**only to the model provider you configured**:

- The chat messages you typed.
- Page or PDF snippets the agent reads on your behalf to complete a task.
- Tool-call descriptions and tool results from agent actions.
When you ask the agent to search the web, the query is sent **directly to
Tavily** using a Tavily API key you add in Settings → Search (subject to
<https://www.tavily.com/privacy>).

These transmissions go **directly from your browser to the provider's API
endpoint — Pie has no proxy in between.** Supported model providers are Anthropic
Claude, OpenAI, Google Gemini, OpenRouter, DeepSeek, MiniMax, GLM (Zhipu),
Bailian, Mimo (Xiaomi), Moonshot (Kimi), and StepFun. Your data is then
subject to that provider's own privacy policy — review the policy of whichever
one you use. Examples:

- **Anthropic** — <https://www.anthropic.com/legal/privacy>
- **OpenAI** — <https://openai.com/policies/privacy-policy>
- **Google** — <https://policies.google.com/privacy>
- **OpenRouter** — <https://openrouter.ai/privacy>
- **MiniMax** — <https://www.minimaxi.com/privacy-policy>
- **GLM / Zhipu (智谱)** — <https://open.bigmodel.cn/proagreement>
- **Bailian (阿里云百炼)** — <https://help.aliyun.com/document_detail/2587688.html>

You are responsible for reviewing the privacy policy of the provider you
choose to use with your own API key.

### Official Pie subscription — optional

If you opt in to the official Pie subscription instead of BYOK, the following
data passes through Pie's own service:

- **Sign-in** — you sign in with Google or email verification code. Pie's account service
  (`account.pie.chat`) receives your **email address** to identify your
  account. Pie does not receive your Google password.
- **Consent & policy updates** — subscribing to Pie Pro or redeeming an
  activation code indicates your default agreement
  to this Privacy Policy and the cloud Memory terms below, and links to the
  official policy page (`https://www.pie.chat/privacy`). Existing subscribers
  upgrading to Pie 2.0 are shown an in-app update prompt on first launch to
  review these updated terms and choose whether to enable or keep cloud Memory
  off before any conversation excerpts are uploaded. If you defer consent on
  one device, a reminder badge remains in **Settings → Account** (and **Settings
  → Memory**) so you can review and agree anytime; once accepted on any device,
  your consent syncs across your signed-in devices. You can withdraw consent or
  disable cloud Memory at any time in **Settings → Memory**.
- **Billing** — payments are handled by **Stripe**. Pie does not see or store
  your card details; it keeps the subscription state Stripe reports back
  (active / canceled / renewal date) and a usage count needed to enforce your
  plan's quota.
- **Chat** — your chat and agent requests are **forwarded** through Pie's
  gateway (`api.pie.chat`) to the model provider. **Pie does not retain or log
  the content of your prompts or the model's responses — the gateway only
  passes them through.**
- **Deep Research** (optional Pie Pro feature) — when you start a Deep Research
  task, your question is queued on `account.pie.chat` and processed using Pie's
  research pipeline and Tavily web search. Completed research reports are
  retained for a limited window and purged automatically.
- **Memory & multi-device sync** (optional Pie Pro feature, requires active
  subscription and your privacy consent; configurable anytime in Settings → Memory):
  - **Consent gate:** no conversation excerpts or browsing history summaries
    are uploaded to Pie's cloud unless you have accepted this Privacy Policy
    (when subscribing/redeeming or via the in-app consent prompt / Memory toggle).
  - **What is sent:** after conversations finish on a non-incognito,
    non-excluded site, the extension prepares a sanitized excerpt containing
    **only your messages and Pie's final conclusions** (web page contents, tool
    outputs, and detected passwords/payment cards/IDs are stripped before upload).
    If you also opt in to the device-local **Browsing history** source, only
    frequent domain names and page titles are summarized.
  - **Transient consolidation:** sanitized excerpts are encrypted at rest on
    Pie's server while queued for daily consolidation, processed by Pie's
    memory consolidator to update your concise user profile and structured
    memory entries, and **deleted from the digest queue immediately once
    consolidated** (or purged after at most 7 days if unconsolidated).
  - **Synced memories & encryption:** your structured memories are synced across
    devices where you sign in with the same Pie account. Sensitive **"Address &
    contact"** entries are encrypted at rest both on Pie's server (per-user
    HKDF-SHA256 + AES-256-GCM) and in each device's local IndexedDB (`AES-GCM`).
  - **Controls & expiration:** you can withdraw consent and turn off automatic
    memory, add excluded domains, inspect/edit/delete individual entries, export
    everything to JSON, or click **Clear all memory** (which deletes both local
    and cloud copies) at any time. If your subscription expires, your existing
    memories remain viewable in read-only mode (for browsing, exporting, or
    deleting) and no new excerpts are uploaded or synced.

So for ordinary Chat use without Memory, Pie's service stores only your email,
subscription status, and quota usage count; when Memory is active, Pie also
holds your consolidated memory entries for multi-device sync until you delete
them. The only way full page tool outputs reach Pie's storage is if you
explicitly send a **Report a problem** submission (see above). Stripe's handling
of payment data is governed by <https://stripe.com/privacy>; Google sign-in by
<https://policies.google.com/privacy>.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `<all_urls>` host permission | Read page content and inject DOM action scripts |
| `tabs`, `tabGroups` | Multi-tab agent tools (list / activate / close / group) |
| `scripting` | `chrome.scripting.executeScript` for DOM operations |
| `webNavigation` | Detect when a pinned tab navigates, so a task acts on the right page |
| `debugger` | CDP keyboard simulation and editor read/write for canvas editors (e.g. Lark Docs); off by default, opt-in toggle in Settings |
| `offscreen` | Parse text from PDFs in an offscreen document |
| `downloads` | Save files the agent produces to your Downloads folder |
| `identity` | Google sign-in for the **optional** official subscription only |
| `alarms` | Wake the extension to run scheduled tasks |
| `notifications` | Notify you when a scheduled task finishes |
| `sidePanel` | Render the Pie UI |
| `storage` | Persist sessions, encrypted API keys, memories, and preferences |
| `activeTab` | Required by some Chrome APIs even when `<all_urls>` is granted |
| `nativeMessaging` *(optional)* | Connect to the optional local Pie Bridge companion app |
| `bookmarks` *(optional)* | Requested on demand if you ask Pie to search or organize your bookmarks |
| `history` *(optional)* | Requested on demand if you search/clean history or enable the Browsing history memory source |

Pie deliberately does **not** request `incognito` window recording, Chrome's
built-in `chrome.storage.sync`, or automatic access to optional permissions at
install time.

## Removing your data

Uninstalling Pie from `chrome://extensions` removes all local state,
including encrypted API keys, sessions, and skills.

If you used the official subscription, your account (email + subscription
state) also lives on Pie's service. Cancel anytime from the in-app billing
portal; to delete the remaining account data, contact us at the address below.

## Data retention

- **On your device:** sessions, skills, and preferences persist locally until
  you delete them or uninstall Pie. Sessions older than 30 days become
  eligible for hard deletion. None of this leaves your device except as part
  of a model request you explicitly trigger.
- **Pie's gateway (subscription only):** does **not** retain the content of
  your prompts or responses — it forwards them and keeps nothing.
- **Pie's account service (subscription only):** keeps your email,
  subscription status, quota usage count, and (for subscribers who use
  Memory) your synced memory entries until you clear them from Settings → Memory
  or request account deletion. Raw unconsolidated session excerpts are deleted
  upon daily consolidation (and auto-purged within 7 days).

## Children's privacy

Pie is not directed to children under 13. For BYOK users, Pie holds no user
data at all. For subscribers, the only data Pie holds is the account email and
subscription state described above.

## Your rights (GDPR / CCPA)

- **BYOK users:** Pie collects, transmits, and stores no personal data on
  Pie-operated servers — all your data is on your own device, under your direct
  control, and is erased by uninstalling the extension. The single exception is
  a problem report you choose to send (see "Reporting a problem"); contact us
  to have one deleted.
- **Subscribers:** the personal data Pie holds is your email,
  subscription/usage state, synced memory entries (while cloud Memory is
  active), plus any problem reports you chose to send. Contact us to access,
  correct, or delete it — or clear your cloud and local memories immediately
  from **Settings → Memory**.
- For data sent to third-party model providers (using your own key) or to
  Stripe (for billing), contact those parties directly to exercise data-subject
  rights against them.

## Changes to this policy

If this policy changes, the `Last updated` date at the top of this document
will be updated and the extension version bumped. The current version is
always available at:

<https://github.com/wiseria-ai-labs/pie-ai-agent/blob/main/PRIVACY.md>

## Contact

- Email: <xiewkevo66@gmail.com>
- Issues: <https://github.com/WiseriaAI/pie-ai-agent/issues>
