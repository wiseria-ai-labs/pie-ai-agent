# Edge Add-ons — store listing copy (zh-TW · ja · es-419 · pt-BR)

> 2026-08-09. Paste into Partner Center → **Store listings** → pick the locale →
> **Description**. One fenced block per locale, ready to copy whole.
>
> **No occurrence of the word "Chrome" anywhere below**, on purpose: Edge's
> package validator warns on store copy that names another browser, and the same
> rule is applied to listing text. Where the README says "Chrome's side panel"
> these say just "the side panel"; where it says "Chrome 114+ or any Chromium
> browser" these say "any browser with side-panel support".
>
> Wording follows the existing translations in `README.<locale>.md` so the store
> page, the repo, and the extension UI all say the same thing. Product facts are
> current as of v1.3.1 (11 BYOK providers, PDFs, Skills, schedules, Pie Link).
>
> The short description is not entered here — Edge takes it from the package's
> `extension_description`, which `scripts/make-edge-package.mjs` swaps for the
> browser-neutral `extension_description_edge` at build time.

---

## 繁體中文 (zh-TW)

```
Pie 是一個會動手用瀏覽器、而不只是陪你聊天的 AI 助理。它開在側邊欄裡，你工作時一直在那兒。用日常語言描述一個任務，Pie 會自己想清楚步驟、在你眼前的頁面上執行 —— 讀取、點擊、輸入、切換分頁 —— 這些活兒不用你再一步步點了。

免費、開源（Apache 2.0）。

■ 你能用它做什麼

• 對目前頁面提問 —— 摘要一篇長文、提煉重點、回答關於它的問題。PDF 也行，不只是一般網頁。
• 把多步任務交給它 ——「比較這三款產品，告訴我哪個最划算」「照我的筆記把這張表填了」。Pie 會拆解步驟，替你點擊、輸入、捲動。
• 跨所有分頁做事 —— 一次從多個開啟的分頁彙整資訊，並幫你收拾整齊：把相關分頁分組、關掉重複的、清掉看完不用的。
• 連網搜尋 —— 目前頁面不夠用時，Pie 會上網查最新資訊。
• 在真正的編輯器裡寫東西 —— 飛書文件、Google Docs、程式碼編輯器這些通常拒絕自動化的富文字編輯器，Pie 也能輸入。
• 把頁面變成檔案 —— 從頁面裡抽取結構化資料，匯出成一個可下載的檔案。
• 儲存並重複使用工作流程（Skill）—— 把常做的任務變成一條 /指令，或者你只示範一遍、讓 Pie 替你把 Skill 做出來。
• 定時跑任務 —— 每天、每週或每隔幾小時自動執行，即使你不在，它也能在背景跑。
• 連接你的電腦（Pie Link）—— 安裝可選的伴侶程式，讓 Pie 使用本機 Skill、執行本機指令稿，並把任務交給 Claude Code、Codex、Cursor 等本機 AI 程式設計工具。

■ 接入模型：自帶 key，或訂閱

自帶 key（BYOK）—— 貼上任一供應商的 API key 即可。免費使用、完全私密：你的 key 在本機加密保存，只發給你選的那家供應商，絕不發往任何 Pie 伺服器。

支援的供應商：Anthropic Claude · OpenAI · Google Gemini · OpenRouter · DeepSeek · MiniMax · GLM（智譜）· Bailian（百鍊）· Mimo（小米）· Moonshot（Kimi，國際區與中國區）· StepFun。

Pie 官方訂閱（可選）—— 不想折騰 key？用 Google 登入並訂閱，開箱即用。這是唯一一條請求會經過 Pie 自家服務的路徑。

■ 隱私

• 你的資料是你的。用 BYOK 時沒有後端介入，Pie 不收集任何埋點或統計。
• 唯一的例外是訂閱：聊天請求會經過 Pie 的服務（計費必需）—— 但仍然不收集任何產品埋點。
• Pie 只在執行你交代的任務時才讀取頁面，並把頁面上的一切都當作不可信內容，這樣惡意頁面也無法騙它去做你沒要求的事。

完整政策：https://github.com/wenkang-xie/pie-ai-agent/blob/main/PRIVACY.md

■ 怎麼開始

1. 安裝 Pie，開啟側邊欄
2. 進設定，貼上你的 API key（或用 Google 登入訂閱）
3. 回到聊天，告訴 Pie 你想做什麼

需要支援側邊欄的瀏覽器。若你的瀏覽器接受側邊欄 API 卻從不繪製面板，在任意頁面按右鍵選擇「在獨立視窗中開啟 Pie」，Pie 會記住這個選擇。

■ 開源

Apache 2.0 授權，原始碼與問題回報：https://github.com/wenkang-xie/pie-ai-agent
官方網站：https://www.pie.chat
```

**Search terms（最多 7 個）**：`AI Agent`、`瀏覽器助理`、`開源`、`BYOK`、`分頁自動化`、`PDF 摘要`、`自動化`

---

## 日本語 (ja)

```
Pie は、ブラウザの中で実際に操作してくれる AI アシスタントです。ただ会話するだけではありません。サイドパネルに開き、作業中はずっとそこにいます。やりたいことを普段の言葉で伝えれば、Pie が手順を考え、目の前のページで実行します —— 読む、クリックする、入力する、タブを切り替える。あなたが一つずつ操作する必要はありません。

無料でオープンソース（Apache 2.0）です。

■ できること

• 開いているページについて質問する —— 長い記事を要約したり、要点を抜き出したり、内容について答えてもらえます。PDF にも対応、通常のウェブページだけではありません。
• 複数ステップの作業を任せる ——「この 3 つの製品を比較して、一番お得なものを教えて」「このメモを元にフォームを埋めて」。Pie が手順を組み立て、クリック・入力・スクロールを代わりに行います。
• すべてのタブをまたいで作業する —— 複数の開いたタブから一度に情報を集め、さらに整理もします。関連するタブをグループ化し、重複を閉じ、見終わったものを片付けます。
• ウェブを検索する —— 今のページだけでは足りないとき、最新の情報を調べます。
• 本物のエディタの中に書き込む —— Google Docs、Lark Docs、コードエディタなど、通常は自動化を受け付けないリッチエディタにも入力できます。
• ページをファイルに変える —— ページから構造化データを抽出し、ダウンロードできるファイルとして書き出します。
• 作業フロー（Skill）を保存して再利用する —— よくやる作業を再利用できる /コマンド にしたり、一度やって見せるだけで Pie に Skill を作ってもらえます。
• 作業をスケジュール実行する —— 毎日・毎週・数時間ごとに自動実行。あなたが離れている間もバックグラウンドで動きます。
• パソコンに接続する（Pie Link）—— 任意のコンパニオンアプリを入れると、ローカルの Skill を使い、ローカルスクリプトを実行し、Claude Code・Codex・Cursor などのローカル AI コーディングツールに作業を引き継げます。

■ モデルを接続する：自分の key、またはサブスクリプション

自分の key を使う（BYOK）—— 下記いずれかのプロバイダーの API key を貼り付けるだけ。無料で使え、完全にプライベートです。key は端末上で暗号化され、選んだプロバイダーにのみ送られます —— Pie のサーバーには一切送られません。

対応プロバイダー：Anthropic Claude · OpenAI · Google Gemini · OpenRouter · DeepSeek · MiniMax · GLM（Zhipu）· Bailian · Mimo（Xiaomi）· Moonshot（Kimi、国際版および中国版）· StepFun。

Pie 公式サブスクリプション（任意）—— key の管理をしたくない方は、Google でログインして購読すればすぐに使えます。リクエストが Pie 自身のサービスを経由するのは、この経路だけです。

■ プライバシー

• あなたのデータはあなたのもの。BYOK ではサーバーを介在させず、テレメトリも分析も一切収集しません。
• 唯一の例外がサブスクリプションです。チャットのリクエストは Pie のサービスを経由します（課金に必要なため）—— それでも製品テレメトリは一切収集しません。
• Pie がページを読むのは、あなたが指示した作業を実行するときだけ。ページ上の内容はすべて信頼できないものとして扱うので、悪意のあるページに指示されて勝手な動作をすることはありません。

プライバシーポリシー全文：https://github.com/wenkang-xie/pie-ai-agent/blob/main/PRIVACY.md

■ 使い方

1. Pie をインストールし、サイドパネルを開く
2. 設定で API key を貼り付ける（または Google でログインして購読）
3. チャットに戻り、やりたいことを伝える

サイドパネルに対応したブラウザが必要です。サイドパネルの API を受け付けながらパネルを描画しないブラウザでは、ページ上で右クリックして「Pie を別ウィンドウで開く」を選んでください。選択は記憶されます。

■ オープンソース

Apache 2.0 ライセンス。ソースコードと不具合報告：https://github.com/wenkang-xie/pie-ai-agent
公式サイト：https://www.pie.chat
```

**Search terms（最大 7 件）**：`AI エージェント`、`ブラウザ AI`、`オープンソース`、`BYOK`、`タブ 自動化`、`PDF 要約`、`自動化`

---

## Español (Latinoamérica) — es-419

```
Pie es un asistente de IA que usa tu navegador, en vez de solo conversar dentro de él. Se abre en el panel lateral y se queda ahí mientras trabajas. Describe una tarea en lenguaje cotidiano y Pie averigua los pasos y los ejecuta en la página que tienes delante — leyendo, haciendo clic, escribiendo, cambiando de pestaña — para que no tengas que hacerlo clic a clic.

Es gratis y de código abierto (Apache 2.0).

■ Qué puedes hacer

• Pregunta sobre la página en la que estás. Resume un artículo largo, extrae los puntos clave, responde preguntas sobre el contenido — incluidos PDF, no solo páginas web normales.
• Delega tareas de varios pasos. "Compara estos tres productos y dime cuál conviene más." "Llena este formulario con mis notas." Pie planifica los pasos y hace los clics, la escritura y el desplazamiento por ti.
• Trabaja entre todas tus pestañas. Reúne información de varias pestañas abiertas a la vez y mantén todo en orden: agrupa las relacionadas, cierra las duplicadas, despeja las que ya no usas.
• Busca en la web. Cuando la página actual no alcanza, Pie consulta para traer información actualizada.
• Escribe dentro de editores de verdad. Pie puede escribir en editores enriquecidos que normalmente ignoran la automatización — Google Docs, Lark Docs y editores de código —, no solo en cuadros de texto simples.
• Convierte páginas en archivos. Extrae datos estructurados de una página y expórtalos como un archivo que puedes descargar.
• Guarda y reutiliza tus flujos (Skills). Convierte una tarea frecuente en un /comando reutilizable, o simplemente hazla una vez grabándola y deja que Pie arme la Skill por ti.
• Programa tareas. Haz que Pie ejecute una tarea automáticamente — a diario, cada semana o cada pocas horas —, incluso en segundo plano mientras no estás.
• Conecta tu computadora (Pie Link). Instala el complemento opcional para que Pie use Skills locales, ejecute scripts locales y delegue tareas a herramientas locales de programación con IA como Claude Code, Codex y Cursor.

■ Conectar un modelo: tu propia clave o suscripción

Trae tu propia clave (BYOK). Pega una clave de API de cualquier proveedor de abajo. Es gratis y totalmente privado: tu clave se cifra en tu dispositivo y se envía solo a ese proveedor — nunca a un servidor de Pie.

Proveedores compatibles: Anthropic Claude · OpenAI · Google Gemini · OpenRouter · DeepSeek · MiniMax · GLM (Zhipu) · Bailian · Mimo (Xiaomi) · Moonshot (Kimi, internacional y China) · StepFun.

Suscripción oficial de Pie (opcional). ¿No quieres lidiar con claves? Inicia sesión con Google y suscríbete: todo funciona de inmediato. Este es el único camino en el que tus solicitudes pasan por el propio servicio de Pie.

■ Privacidad

• Tus datos son tuyos. Con BYOK no hay ningún servidor de por medio, y Pie no recopila telemetría ni analíticas.
• La única excepción es la suscripción: las solicitudes del chat pasan por el servicio de Pie (es necesario para la facturación), pero aun así no se recopila telemetría del producto.
• Pie solo lee la página cuando ejecuta la tarea que le pediste, y trata todo lo que hay en ella como contenido no confiable, de modo que una página maliciosa no pueda engañarlo para hacer algo que tú no pediste.

Política completa: https://github.com/wenkang-xie/pie-ai-agent/blob/main/PRIVACY.md

■ Cómo empezar

1. Instala Pie y abre el panel lateral
2. En Configuración, pega tu clave de API (o inicia sesión con Google y suscríbete)
3. Vuelve al chat y dile a Pie qué quieres hacer

Requiere un navegador con panel lateral. Si el tuyo acepta la API del panel lateral pero nunca lo muestra, haz clic derecho en cualquier página y elige "Abrir Pie en una ventana aparte": Pie recuerda tu elección.

■ Código abierto

Licencia Apache 2.0. Código fuente y reporte de errores: https://github.com/wenkang-xie/pie-ai-agent
Sitio oficial: https://www.pie.chat
```

**Search terms (máx. 7)**: `agente de IA`, `IA navegador`, `código abierto`, `BYOK`, `automatizar pestañas`, `resumir PDF`, `asistente IA`

---

## Português (Brasil) — pt-BR

```
O Pie é um assistente de IA que usa o seu navegador, em vez de apenas conversar dentro dele. Ele abre no painel lateral e fica ali enquanto você trabalha. Descreva uma tarefa em linguagem do dia a dia e o Pie descobre os passos e os executa na página à sua frente — lendo, clicando, digitando, trocando de abas — para você não precisar fazer isso clique a clique.

É gratuito e de código aberto (Apache 2.0).

■ O que você pode fazer

• Pergunte sobre a página em que você está. Resuma um artigo longo, extraia os pontos principais, tire dúvidas sobre o conteúdo — inclusive PDFs, não só páginas web comuns.
• Delegue tarefas de vários passos. "Compare estes três produtos e diga qual tem o melhor custo-benefício." "Preencha este formulário com as minhas anotações." O Pie planeja os passos e faz os cliques, a digitação e a rolagem por você.
• Trabalhe entre todas as suas abas. Reúna informações de várias abas abertas de uma vez e mantenha tudo organizado: agrupe as relacionadas, feche duplicadas, limpe as que você já não usa.
• Pesquise na web. Quando a página atual não basta, o Pie busca informações atualizadas.
• Escreva dentro de editores de verdade. O Pie consegue digitar em editores ricos que normalmente ignoram automação — Google Docs, Lark Docs e editores de código —, não apenas em caixas de texto simples.
• Transforme páginas em arquivos. Extraia dados estruturados de uma página e exporte como um arquivo para baixar.
• Salve e reaproveite seus fluxos (Skills). Transforme uma tarefa frequente em um /comando reutilizável, ou apenas faça-a uma vez gravando e deixe o Pie montar a Skill para você.
• Rode tarefas no horário marcado. Faça o Pie executar uma tarefa automaticamente — diariamente, semanalmente ou a cada poucas horas —, até em segundo plano enquanto você está fora.
• Conecte seu computador (Pie Link). Instale o complemento opcional para que o Pie use Skills locais, execute scripts locais e delegue tarefas a ferramentas locais de programação com IA como Claude Code, Codex e Cursor.

■ Conectar um modelo: sua chave ou assinatura

Traga a sua chave (BYOK). Cole uma chave de API de qualquer provedor abaixo. É gratuito de usar e totalmente privado: a sua chave é criptografada no seu dispositivo e enviada apenas para aquele provedor — nunca para um servidor do Pie.

Provedores suportados: Anthropic Claude · OpenAI · Google Gemini · OpenRouter · DeepSeek · MiniMax · GLM (Zhipu) · Bailian · Mimo (Xiaomi) · Moonshot (Kimi, internacional e China) · StepFun.

Assinatura oficial do Pie (opcional). Não quer gerenciar chaves? Entre com o Google e assine: tudo funciona de imediato. Esse é o único caminho em que as suas solicitações passam pelo serviço do próprio Pie.

■ Privacidade

• Seus dados são seus. Com BYOK não há nenhum servidor no meio, e o Pie não coleta telemetria nem analytics.
• A única exceção é a assinatura: as solicitações do chat passam pelo serviço do Pie (necessário para a cobrança), mas ainda assim nenhuma telemetria de produto é coletada.
• O Pie só lê a página quando executa a tarefa que você pediu, e trata tudo o que está nela como conteúdo não confiável, para que uma página maliciosa não consiga enganá-lo e fazer algo que você não pediu.

Política completa: https://github.com/wenkang-xie/pie-ai-agent/blob/main/PRIVACY.md

■ Como começar

1. Instale o Pie e abra o painel lateral
2. Em Configurações, cole a sua chave de API (ou entre com o Google e assine)
3. Volte ao chat e diga ao Pie o que você quer fazer

Requer um navegador com painel lateral. Se o seu aceita a API do painel lateral mas nunca o exibe, clique com o botão direito em qualquer página e escolha "Abrir o Pie em uma janela separada" — o Pie lembra da sua escolha.

■ Código aberto

Licença Apache 2.0. Código-fonte e relato de bugs: https://github.com/wenkang-xie/pie-ai-agent
Site oficial: https://www.pie.chat
```

**Search terms (máx. 7)**: `agente de IA`, `IA navegador`, `código aberto`, `BYOK`, `automatizar abas`, `resumir PDF`, `assistente IA`
