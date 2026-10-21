# Google Docs in Pie via MCP (Arch Linux)

Pie can call tools on remote MCP servers (Settings → **MCP servers**). This guide
connects it to a local Google Docs server so the agent edits Docs through the
Docs API — exact indices and anchors — instead of typing into the canvas editor.

**Server:** [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
(`workspace-mcp` on PyPI, MIT). Chosen because it:

- reads document structure with indices — `inspect_doc_structure` (`detailed: true`
  → `start_index` / `end_index` per paragraph), `get_doc_content`, `get_doc_as_markdown`;
- inserts / replaces at a precise location — `modify_doc_text(document_id, start_index,
  end_index?, text)` and `batch_update_doc` with `insert_text` ops targeted by `index`,
  `anchor_text` (+ `anchor_position: "before" | "after"`, must match exactly once),
  `after_heading` / `before_heading`, or `end_of_segment`;
- speaks MCP **Streamable HTTP** natively (no stdio bridge) and has a `--single-user`
  mode that needs no client-side auth — Pie only sends static headers;
- runs locally with your own Google OAuth client; tokens stay on disk.

Verified with workspace-mcp 2.1.1 (server 4.1.2, MCP protocol 2025-11-25): 19 Docs
tools at `--tool-tier complete`; read-only tools carry `readOnlyHint`, so Pie
classifies them as read and everything else as write.

## 1. Install

```sh
sudo pacman -S --needed uv
uv tool install workspace-mcp          # → ~/.local/bin/workspace-mcp
workspace-mcp --help                    # sanity check
```

Upgrade later with `uv tool upgrade workspace-mcp`.

## 2. Google OAuth client (once)

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create (or pick) a project.
2. **APIs & Services → Library**: enable **Google Docs API** and **Google Drive API**.
3. **Google Auth Platform → Branding / Audience**: user type *External*, publishing
   status *Testing*, and add your Google account under **Test users**.
4. **Clients → Create client → Application type: Desktop app** → **Download JSON**
   (the secret is shown only in that dialog).

Check that **Audience → Test users** really lists your account after saving. If it
doesn't, Google refuses the sign-in with *"Error 403: access_denied"*.

Keep the client file and settings in files only you can read:

```sh
mkdir -p ~/.config/workspace-mcp
install -m 600 ~/Downloads/client_secret_*.json ~/.config/workspace-mcp/client_secret.json
install -m 600 /dev/null ~/.config/workspace-mcp/env
cat > ~/.config/workspace-mcp/env <<'EOF'
# Either the downloaded JSON …
GOOGLE_CLIENT_SECRET_PATH=/home/you/.config/workspace-mcp/client_secret.json
# … or the two values from it:
# GOOGLE_OAUTH_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
# GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxx
USER_GOOGLE_EMAIL=you@gmail.com
WORKSPACE_MCP_PORT=8000
# The OAuth redirect (http://localhost:8000/oauth2callback) is plain http on loopback.
OAUTHLIB_INSECURE_TRANSPORT=1
# The server answers 403 "Origin not allowed" to unknown origins. Pie's extension ID
# is pinned by manifest.key, so this value is the same for every Pie install.
OAUTH_ALLOWED_ORIGINS=chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed
EOF
```

`USER_GOOGLE_EMAIL` makes the tools' `user_google_email` argument optional, so the
agent doesn't have to guess it. Tokens are cached in `~/.google_workspace_mcp/credentials/`
(override with `WORKSPACE_MCP_CREDENTIALS_DIR`).

## 3. Run it

Foreground, to try it out:

```sh
set -a; . ~/.config/workspace-mcp/env; set +a
workspace-mcp --single-user --transport streamable-http --tools docs --tool-tier complete
# → Uvicorn running on http://127.0.0.1:8000  (MCP endpoint: /mcp)
```

`--tools docs` keeps the tool list to the 19 Docs tools (add `drive` if you also want
Drive file tools). The server binds to 127.0.0.1 only.

### systemd --user unit

`~/.config/systemd/user/workspace-mcp.service`:

```ini
[Unit]
Description=Google Workspace MCP server (Docs) for Pie
After=network-online.target

[Service]
EnvironmentFile=%h/.config/workspace-mcp/env
ExecStart=%h/.local/bin/workspace-mcp --single-user --transport streamable-http --tools docs --tool-tier complete
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now workspace-mcp
journalctl --user -u workspace-mcp -f     # logs
```

## 4. Add it to Pie

Settings → **MCP servers** → **Add server**:

| Field      | Value                          |
|------------|--------------------------------|
| Name       | `Google Docs` (tools become `mcp__google_docs__*`) |
| Server URL | `http://localhost:8000/mcp`    |
| Headers    | none                           |
| Permission | *Always allow* (your own local server) or *Ask once per session* |

Press **Test** → "Connected — 19 tools". Common failures:

- `HTTP 403 — {"error":"Origin not allowed"}` → `OAUTH_ALLOWED_ORIGINS` missing or wrong.
- `cannot reach http://localhost:8000/mcp` → server not running (`systemctl --user status workspace-mcp`).

## 5. First Google sign-in

The first Docs tool call returns *"ACTION REQUIRED: Google Authentication Needed"* with
an authorization URL; Pie's agent shows it to you. Open it. Because the app is in
*Testing*, Google first shows *"Google hasn't verified this app"* → **Continue**; then
tick the requested Docs/Drive permissions → **Continue**. The browser lands on
`http://localhost:8000/oauth2callback` (served by workspace-mcp; a Desktop-app client
accepts this loopback redirect), and the token is saved to
`~/.google_workspace_mcp/credentials/<email>.json`. Then ask Pie to retry. This happens
once — the token is refreshed automatically afterwards.

## 6. Using it

In a Pie chat: *"Fill the empty line under each question in https://docs.google.com/document/d/…/edit"*.
The agent loads the `mcp:google_docs` tool group, reads the structure with
`inspect_doc_structure` (paragraph indices), and inserts each answer at the empty
paragraph's `start_index` via `batch_update_doc` (inserts applied from the bottom of the
document up, so earlier indices don't shift).

## 7. End-to-end verification (2026-10-20)

Run against a real Google Doc with workspace-mcp 2.1.1 behind `systemd`-equivalent
flags on `:8000`, driven by Pie's own MCP client code (`src/lib/mcp/client.ts`,
compiled and run outside the extension, sending Pie's `chrome-extension://` Origin):

1. `create_doc` — a doc with a title line, 3 numbered questions, an empty line under
   each, and a closing line.
2. `inspect_doc_structure {detailed: true}` — reported `empty_paragraph_ranges`
   37–38, 60–61, 84–85: exactly the three empty lines.
3. `batch_update_doc` — one call, three `insert_text` ops at index 84, 60, 37 (bottom-up).
4. `get_doc_content` before vs after:

   ```
   before: Questionnaire | 1. What is your name? | (empty) | 2. Where do you live? | (empty) | 3. What is your hobby? | (empty) | End of form.
   after:  Questionnaire | 1. What is your name? | Alex    | 2. Where do you live? | Lisbon  | 3. What is your hobby? | Hiking and chess | End of form.
   ```

   Every non-empty line is unchanged; each answer is on its own former empty line
   (also checked visually in the Docs editor).
5. A non-unique anchor (`anchor_text: "What is"`) is refused —
   *"matches 2 locations (at indices 25, 81)"* — and the document is left unchanged.

Not covered by this run: the model choosing these tools by itself inside Pie's side
panel (manual check: add the server, then ask Pie to fill the empty lines), and docs
whose questions are real Docs list items (`is_list_item: true` paragraphs; the empty
line under a list item may itself be an empty list item).

Known quirk: workspace-mcp reports some failures — like the ambiguous anchor above —
as normal text starting with `Error:` with `isError: false`, so Pie shows them to the
model as a successful call whose text is an error message. The model still sees the
message.
