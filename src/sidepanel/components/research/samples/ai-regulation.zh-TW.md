---
sources: 35
searches: 9
minutes: 3.5
---

# 2026年AI監管：前沿模型授權門檻、訓練資料透明度與跨境評估協議之比較

2026年，AI監管分散於具約束力的歐盟規則、美國由各州法律與行政命令拼湊而成的體系，以及大致上屬自願性質的國際評估安排之間 [19][33][16]。歐盟《人工智慧法案》是最正式化的途徑：具系統性風險義務的通用型AI適用於訓練運算量超過10^25 FLOP的模型，而美國的相關工具則普遍採用10^26的運算門檻，或完全避免授權機制 [1][4][5]。訓練資料透明度方面，美國透過加州AB 2013法案進展最為領先，該法案已生效並挺過了初步禁制令的挑戰，惟缺乏明確罰則；歐盟第50條的透明度義務則自2026年8月起適用 [6][8][14]。跨境評估大致上不具約束力，主要圍繞「國際先進AI測量、評估與科學網絡」、雙邊安全協議，以及美國自願性的CAISI部署前測試協議 [16][17][20]。

## 2026年主要司法管轄區當前前沿模型授權門檻為何？

在超國家層級，歐盟《人工智慧法》（EU AI Act）是最明確以門檻為基礎的監管制度。其對具系統性風險的通用人工智慧提供者課予義務，包括使用超過10^25次浮點運算（FLOP）訓練的系統[1]。這些通用人工智慧義務已於2025年8月生效[1]。系統性風險條款的核心適用日期為2026年8月2日，屆時最大的前沿模型提供者將面臨對抗性測試協議及詳細風險評估文件的要求[2]。歐盟《人工智慧法》第50條的透明度要求亦自2026年8月2日起適用，要求揭露人類與人工智慧系統互動的情形，並對合成內容進行機器可讀標記[3]。然而，歐盟的高風險人工智慧義務已透過《數位綜合方案》（Digital Omnibus）延後至2027年12月2日[3]。透明度違規的行政罰鍰最高可達1,500萬歐元或全球年度營業額的3%[3]。

截至2026年6月，美國並無正式的人工智慧模型發布前授權制度[4]。第14409號行政命令建立自願性框架，要求開發者在計畫發布前最多30天讓聯邦政府取得涵蓋範圍內的前沿模型，但該命令明確表示其中任何內容均未授權政府強制性的授權、預先審查或許可要求[4]。一項原本將建立類似FDA式前沿人工智慧模型發布前審查程序的白宮行政命令，已於2026年5月22日被取消[2]。2026年4月，白宮對Anthropic的Claude Mythos Preview的非正式否決，被描述為缺乏法律依據的非正式授權制度，因為政府透過行政壓力對私人產品的流通行使了實質控制權，卻無授權法規、無明確標準，亦無申訴或審查機制[2]。美國的《人工智慧擴散框架》（AI Diffusion Framework）使用10^26 FLOP的訓練運算門檻來識別須面對多項要求的「受管制模型」[1]。

在州層級，加州SB 53法案自2026年1月1日生效，被描述為美國目前施行中最具操作實質性的前沿人工智慧揭露義務；其要求超過10^26 FLOP訓練門檻的涵蓋模型在十五天內進行安全事件通報[2]。SB 53適用於使用超過10^26次運算訓練前沿模型的開發者，其中年度總收入超過5億美元的大型前沿開發者負有最嚴格的義務[5]。民事罰款最高可達每次違規100萬美元，視情節輕重而定[5]。在伊利諾州，年度收入超過5億美元的大型前沿開發者必須自2028年1月1日起委託獨立第三方進行年度稽核[3]。科羅拉多州SB 26-189法案自2027年1月1日生效，要求用於重大決策的自動化決策技術之開發者與部署者，在做出不利決策後提供消費者通知與說明[5]。

在聯邦層級，《2026年人工智慧基礎模型透明度法案》（H.R. 8094）將指示聯邦貿易委員會（FTC）為高影響力基礎模型建立揭露標準，但未建立授權權限[2]。《先進人工智慧安全整備法案》（H.R. 3919）指示國家安全局（NSA）局長制定《人工智慧安全手冊》，但明確表示其未授權對人工智慧公司採取監管或執法行動[2]。

在英國，相關資料未指出正式的法定授權門檻。英國人工智慧安全研究院（UK AI Security Institute）在Anthropic發布Claude Mythos後六天內公布了獨立的網路能力評估結果，發現Mythos是第一個完成32步驟模擬網路攻擊演練的人工智慧[2]。部長們亦確認，《網路安全與韌性法案》（Cyber Security and Resilience Bill）將因應人工智慧輔助的網路威脅而重返國會審議[2]。

## 2026年各國政府如何執行AI模型的訓練資料透明度要求？

加州AB 2013法案於2026年1月1日生效，是美國境內一項核心的訓練資料透明度措施[6]。該法案要求生成式AI系統的開發者公開揭露用於訓練其模型的詳細資料，包括資料集來源、資料類型、是否使用受版權保護的素材，以及是否包含個人資訊[6]。開發者必須在其網站上發布一份涵蓋12個指定類別的高階摘要，包括資料集的來源或所有者，以及該系統在開發過程中是否使用或持續使用合成資料生成[9]。

在執法方面，AB 2013並未指定執法機制或罰則，但可能依據加州《不正當競爭法》執行[12]。2026年3月4日，聯邦地方法院駁回了xAI針對AB 2013提出的初步禁制令動議，使該法律得以繼續生效[8]。OpenAI和Anthropic已依據該法律發布揭露資訊，但這些資訊仍屬高階層級，並未指明用於訓練其模型的具體資料集[11]。加州的AI透明度框架由四項獨立工具組成：SB 942、AB 2013、SB 53及CPPA ADMT法規，各有不同的適用範圍和生效日期[10]。

加州SB 942法案（經AB 853修訂）要求每月加州用戶超過100萬的涵蓋生成式AI供應商，在AI生成的圖片、影片和音訊中嵌入符合C2PA標準的潛在浮水印，並提供免費的公開偵測工具；其施行日期從2026年1月1日延後至2026年8月2日，以與歐盟AI法案第50條的時程保持一致[13]。

在聯邦層級，TRAIN法案於2026年1月22日提出，將賦予版權持有人存取AI訓練資料的權利，使其能夠驗證其作品是否在未經授權的情況下被使用；該法案將允許版權持有人在無需事先司法審查的情況下，傳喚AI訓練資料[7]。2025年12月11日的一項行政命令表明，聯邦政府有意整合AI監管權責，並挑戰各州繁重的AI法規，但該命令並未優先於、暫停或廢止目前及已制定的州級AI法律[15]。

在歐盟，AI法案第50條要求聊天機器人揭露身分及對合成內容進行標示，執法將於2026年8月2日開始[14]。科羅拉多州最初的AI法案SB 24-205原定於2026年6月30日生效，但在xAI訴Weiser案後執法已暫停；科羅拉多州議員已推進SB 26-189作為替代框架，重點聚焦於自動化決策技術，若獲通過，主要義務將於2027年1月1日開始施行[14]。

## 2026年存在哪些跨境AI評估協議，以及它們如何被實施？

主要的跨國機制是「國際先進AI測量、評估與科學網絡」（International Network for Advanced AI Measurement, Evaluation and Science），前身為「國際AI安全研究所網絡」（International Network of AI Safety Institutes），成員包括澳洲、加拿大、歐盟、法國、日本、肯亞、韓國、新加坡、英國與美國 [16]。2025年，網絡成員齊聚聖地牙哥，配合NeurIPS會議，就評估最佳實務建立共識 [16]。成員已確認的共識領域包括：評估需有明確目標、透明度與可重現性、品質保證、獨立報告、易於理解的主要發現、強化效度，以及考量不同語言與文化 [16]。仍有開放性問題，包括評估是否應採用風險模型、評估者應優先考量什麼、應分享哪些資訊、報告範本應有多大的彈性，以及如何測試AI系統而非僅測試模型 [16]。作為2026年的網絡協調者，英國將於今年稍後主導將共享學習轉化為更詳細的最佳實務文件 [16]。

在雙邊層面，澳洲與加拿大於2026年初簽署《AI安全合作協議》，旨在透過「國際AI安全研究所網絡」加強AI安全合作 [17]。澳洲與英國於2026年5月下旬簽署《諒解備忘錄》，據此，澳洲AI安全研究所與英國AI安全研究所（UK AI Security Institute）將在分享新興AI能力與風險的資訊及專業知識、測試AI系統的最佳實務、進行聯合研究，以及支持「國際先進AI測量、評估與科學網絡」等方面展開合作 [17]。

《2026年國際AI安全報告》（International AI Safety Report 2026）於2026年2月發布，由Yoshua Bengio主導，超過100位AI專家撰寫，並獲30多個國家與國際組織支持 [18]。該報告聚焦於AI能力前沿所產生的「新興風險」，並將於印度AI影響峰會（India AI Impact Summit）上展示 [18]。

2026年5月5日，Google DeepMind、微軟（Microsoft）與xAI與美國AI標準與創新中心（CAISI）簽署協議，提供其前沿AI模型供部署前測試的早期取用 [20]。這些協議使參與CAISI部署前審查計畫的前沿實驗室總數增至五家，OpenAI與Anthropic先前已建立合作關係 [20]。CAISI已完成超過40項評估，包括對尚未公開的前沿模型之評估 [20]。其進行評估的權限完全依賴自願參與，因為該中心僅能評估開發者選擇分享的模型 [20]。2026年3月，CAISI與美國總務管理局（General Services Administration）正式簽署《諒解備忘錄》，將其評估方法延伸至聯邦AI採購，透過USAi安全生成式AI平台執行 [20]。其任務包括評估前沿AI在網路作戰、生物安全、化學與生物威脅領域，以及操控能力方面的能力 [20]。CAISI已發布DeepSeek V4 Pro的評估結果 [20]。

微軟於2026年5月5日宣布與CAISI及英國AI安全研究所（UK AI Security Institute）達成協議 [21]。與CAISI的合作包括改善對抗性評估的方法，以及共同開發系統性且可重現的評估途徑 [21]。與英國AISI的合作涵蓋前沿安全與保安研究，包括評估高風險能力與防護措施的方法，以及社會韌性研究 [21]。微軟亦透過「國際AI測量、評估與科學網絡」，與全球其他AI研究所進行研究與評估，並貢獻於MLCommons，包括擴大AILuminate以支援多語言、多文化與多模態評估的努力 [21]。

歐盟計畫啟動一項徵案，以在AI模型投放歐盟市場前提升歐盟的評估能力，預計於2027年前運作 [19]。一份已發布的報告亦指出，白宮即將準備一項行政命令，以建立針對所有新AI模型的審查制度 [22]。

## 2026年主要監管路徑在進展與執法方面如何比較？

三條監管路徑在法律效力與執法成熟度上差異顯著 [19][20][33]。

在前沿模型授權門檻方面，歐盟路徑最具約束力。歐盟《人工智慧法》對具有系統性風險的通用人工智慧課予義務，包括以超過10^25 FLOP訓練的模型 [1]。治理與執法條款自2026年8月2日起適用，人工智慧辦公室對GPAI模型擁有執法權力 [19]。然而，歐盟的高風險義務已被延後：獨立附件三系統從2026年8月2日推遲至2027年12月2日 [3][26]。美國沒有聯邦授權制度，第14409號行政命令明確排除強制授權、預先核准或許可 [4]。加州SB 53等州級措施課予揭露與申報義務，而非上市前核准，但設有民事罰則 [2][5]。白宮對Claude Mythos Preview的非正式否決，說明了在法定授權框架之外的行政壓力 [2]。

在訓練資料透明度方面，加州AB 2013是美國最具可操作性的措施：該法已生效、在初步禁制令挑戰中勝訴，並已產生高層級的揭露成果，但缺乏明確罰則 [6][8][11][12]。歐盟第50條透明度義務於2026年8月生效，違反透明度的執法罰款最高可達1,500萬歐元或全球年度營業額的3% [3][14]。在美國聯邦層級，《TRAIN法案》仍屬提案而非已制定法律 [7]。2025年12月的聯邦行政命令顯示對州級規則的施壓，但並未立即使其失效 [15]。

在跨境評估方面，進展已具操作性但大致屬自願性質。國際網絡已產出共識領域與開放問題，而非可強制執行的標準 [16]。澳洲—加拿大及澳洲—英國等雙邊協議屬於合作工具 [17]。《2026年國際人工智慧安全報告》提供了共享的科學證據基礎，但本身並不創設法律義務 [18]。CAISI的上市前評估完全基於開發者的自願參與 [20]。微軟與CAISI及英國人工智慧安全研究所的協議，說明了此路徑的自願、夥伴導向特性 [21]。

在所有路徑中，歐盟《人工智慧法》仍是全球具約束力、風險分級人工智慧合規的最高基準，多數義務於2026年生效 [28][33]。美國2026年的聯邦立場傾向輕觸式、創新優先的監管，並積極推動優先於州級人工智慧法律，但優先權之主張仍具爭議且尚未解決 [33]。州級立法活動十分密集：截至2026年3月，45個州的州議員已提出1,561項人工智慧相關法案 [23]；截至2026年7月1日，各州已制定109項人工智慧法律 [24]。FTC一直是聯邦層級人工智慧執法最積極的機構，運用其在《FTC法》第5條下的既有權限，針對不公平或欺騙性人工智慧行為 [27]。全球至少有72個國家已提出超過1,000項人工智慧相關政策倡議與法律框架，但在多數情況下，這些政策尚未轉化為具法律約束力的規範 [30][35]。

## 未經證實

本報告中未包含任何未引用的事實陳述。

## 局限 / 未涵蓋

沒有任何子問題被跳過。本報告僅限於所提供的筆記內容，且未納入除直接引用或間接引述外的主要立法文本。這些筆記本身屬於二手來源，且其中存在一些衝突；例如，一項來源指出 OpenAI 與 Anthropic 於 2025 年 9 月建立了 CAISI 合作關係，而另一項來源則表示他們於 2024 年 8 月簽署了類似協議 [20][22]。除所引用範例之外的執法結果，例如實際的 AB 2013 罰款裁決，或待審法案與行政行動的最終命運，均未涵蓋於所提供的材料中。

## 參考文獻

[1] Trends in Frontier AI Model Count: A Forecast to 2028 — https://arxiv.org/html/2504.16138v1
[2] Post-Mythos AI Model Regulation: Licensing and Disclosure Frameworks – Lab Space — https://labs.cloudsecurityalliance.org/research/csa-research-note-post-mythos-ai-model-regulation-policy-lan
[3] AI Regulation Hits Hard in H2 2026 — https://kaynemcgladrey.com/blog/halfway-through-2026-ai-regulation-is-no-longer-theoretical
[4] Promoting Advanced Artificial Intelligence Innovation and ... — https://www.whitehouse.gov/presidential-actions/2026/06/promoting-advanced-artificial-intelligence-innovation-and-security
[5] AI Regulations Around the World: A 2026 Guide — https://www.bdemerson.com/article/ai-regulations-around-the-world
[6] AI Legal Updates: California's AI Training Data Transparency Law Takes Effect - Davis+Gilbert LLP — https://www.dglaw.com/ai-legal-updates-californias-ai-training-data-transparency-law-takes-effect
[7] The “TRAIN Act”: Forcing Transparency in AI Training Data - Berkeley Technology Law Journal — https://btlj.org/2026/05/the-train-act-forcing-transparency-in-ai-training-data
[8] California District Court upholds transparency requirements for generative AI training data — https://www.nortonrosefulbright.com/en-us/knowledge/publications/c1df8419/california-district-court-upholds-transparency-requirements-for-generative-ai-training-data
[9] Countdown to Jan. 1, 2026: Preparing for California’s New AI Training Data Transparency Obligations, Andrew Folks — https://technologylaw.fkks.com/post/102lx5o/countdown-to-jan-1-2026-preparing-for-californias-new-ai-training-data-transp
[10] California AI Transparency Law: What Businesses Need to ... — https://secureprivacy.ai/blog/california-ai-transparency-law
[11] California’s AB 2013 Takes Effect: Navigating AI Training Data Transparency and Trade Secret Risk | Insights & Resources | Goodwin — https://www.goodwinlaw.com/en/insights/publications/2026/01/alerts-otherindustries-californias-ab-2013-takes-effect
[12] California’s AB 2013 Requires Generative AI Data Disclosure by January 1, 2026 — https://www.crowell.com/en/insights/client-alerts/californias-ab-2013-requires-generative-ai-data-disclosure-by-january-1-2026
[13] AI Transparency Laws by State: 2026 Requirements — https://www.ailawsbystate.com/blog/ai-transparency-disclosure-requirements-state-by-state
[14] AI Transparency and Disclosure Requirements: a CEO's Guide for 2026 | LaunchReady.ai Insights — https://launchready.ai/insights/ai-governance/ai-transparency-disclosure-requirements
[15] 2026 AI Laws Update: Key Regulations and Practical ... — https://www.gunder.com/en/news-insights/insights/2026-ai-laws-update-key-regulations-and-practical-guidance
[16] International consensus and open questions in AI evaluations | AISI Work — https://www.aisi.gov.uk/blog/international-ai-network-consensus-and-open-questions
[17] International AI Legal Landscape (2026) - SafeAI-Aus — https://safeaiaus.org/safety-standards/international-ai-legal-overview
[18] International AI Safety Report 2026 — https://internationalaisafetyreport.org/publication/international-ai-safety-report-2026
[19] AI Act | Shaping Europe's digital future - European Union — https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai
[20] CAISI Frontier Testing Agreements Reach Five Labs – Lab Space — https://labs.cloudsecurityalliance.org/research/csa-research-note-caisi-frontier-ai-testing-agreements-20260
[21] Advancing AI evaluation with the Center for AI Standards (US) and Innovation and the AI Security Institute (UK) - Microsoft On the Issues — https://blogs.microsoft.com/on-the-issues/2026/05/05/advancing-ai-evaluation-with-the-center-for-ai-standards-us-and-innovation-and-the-ai-security-institute-uk
[22] US government agency to safety test frontier AI models before release | CIO — https://www.cio.com/article/4168122/us-government-agency-to-safety-test-frontier-ai-models-before-release.html
[23] State AI Legislation Tracker 2026: All 50 States — https://www.multistate.ai/artificial-intelligence-ai-legislation
[24] Where State AI Legislation Stands Half Way Into 2026 — https://techpolicy.press/where-state-ai-legislation-stands-half-way-into-2026
[25] AI Regulation in 2026: Navigating an Uncertain Landscape — https://www.holisticai.com/blog/ai-regulation-in-2026-navigating-an-uncertain-landscape
[26] AI Regulation: How It Works, What It Requires, and ... — https://www.kiteworks.com/cybersecurity-risk-management/ai-regulation-2026-business-compliance-guide
[27] US AI regulations 2026: the state laws you must comply with — https://verifywise.ai/blog/state-of-ai-governance-regulations-united-states-2026
[28] AI Compliance Guide 2026: Global Regulations | Modulos — https://www.modulos.ai/ai-compliance-guide
[29] AI Watch: Global regulatory tracker - United States — https://www.whitecase.com/insight-our-thinking/ai-watch-global-regulatory-tracker-united-states
[30] AI Regulations Worldwide in 2026: 72 Countries Propose 1000+ Initiatives | Mind Foundry posted on the topic | LinkedIn — https://www.linkedin.com/posts/mind-foundry_ai-regulations-around-the-world-in-2026-activity-7415023805464518657-0v4T
[31] High-level summary of the AI Act — https://artificialintelligenceact.eu/high-level-summary
[32] Global AI Roundup March 2026 | New Laws, EU AI Act Progress & Global Shifts — https://www.youtube.com/watch?v=a6nCg3KoNTE
[33] AI regulatory compliance in 2026: EU AI Act, US orders ... — https://www.collibra.com/blog/ai-regulatory-compliance-in-2026-eu-ai-act-us-orders-and-state-laws-and-how-to-operationalize
[34] 2026 AI Regulation Guide for Legal and Compliance Leaders — https://www.cimplifi.com/resources/the-ai-regulation-landscape-for-2026-what-legal-and-compliance-leaders-need-to-know
[35] Comprehensive Guide to AI Laws and Regulations ... — https://sumsub.com/blog/comprehensive-guide-to-ai-laws-and-regulations-worldwide
