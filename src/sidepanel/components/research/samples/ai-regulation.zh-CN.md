---
sources: 35
searches: 9
minutes: 3.5
---

# 2026年人工智能监管：前沿模型许可门槛、训练数据透明度与跨境评估协议比较

2026年，人工智能监管在具有约束力的欧盟规则、美国各州法律与行政命令拼凑而成的体系，以及大体上自愿性的国际评估安排之间呈现分化态势 [19][33][16]。欧盟《人工智能法案》是最为正式化的路径：具有系统性风险义务的通用人工智能适用于训练计算量超过10^25 FLOP的模型，而美国相关文书通常采用10^26计算阈值或完全避免许可制度 [1][4][5]。训练数据透明度在美国进展最为深入，依据加州AB 2013法案，该法案已生效并在初步禁令挑战中得以维持，但未规定具体处罚措施；欧盟第50条透明度义务自2026年8月起适用 [6][8][14]。跨境评估大体上不具有约束力，主要围绕国际先进人工智能测量、评估与科学网络、双边安全协议以及美国自愿性CAISI部署前测试协议展开 [16][17][20]。

## 2026年主要司法辖区当前前沿模型许可门槛是什么？

在超国家层面，欧盟《人工智能法案》是最清晰的基于门槛的监管制度。它对具有系统性风险的通用人工智能提供商施加要求，包括使用超过10^25次浮点运算（FLOP）训练的模型[1]。这些通用人工智能义务于2025年8月生效[1]。系统性风险条款的核心适用日期为2026年8月2日，届时最大的前沿模型提供商将面临对抗性测试协议和详细风险评估文档方面的要求[2]。欧盟《人工智能法案》第50条下的透明度要求也于2026年8月2日开始适用，要求在与人工智能系统交互时进行披露，并对合成内容进行机器可读标记[3]。然而，欧盟的高风险人工智能义务通过《数字综合方案》被推迟至2027年12月2日[3]。透明度违规的行政罚款最高可达1500万欧元或全球年营业额的3%[3]。

截至2026年6月，美国没有针对人工智能模型的正式发布前许可制度[4]。第14409号行政令建立了一个自愿框架，要求开发者在前沿模型计划发布前最多30天向联邦政府提供访问权限，但该行政令明确表示其中任何内容均不授权强制性的政府许可、预审或批准要求[4]。一项本将为前沿人工智能模型建立类似FDA的发布前审查程序的行政令已于2026年5月22日被取消[2]。2026年4月，白宫对Anthropic的Claude Mythos Preview的非正式否决被描述为一种缺乏法定依据的非正式许可制度，因为政府通过行政压力对私人产品的分发实施了有效控制，既无授权法规，也无明确标准，更无申诉或审查机制[2]。美国《人工智能扩散框架》使用10^26 FLOP的训练计算门槛来识别面临多项要求的“受控模型”[1]。

在州层面，加利福尼亚州的SB 53法案自2026年1月1日起生效，被描述为美国当前生效的最具操作性的前沿人工智能披露强制令；它要求超过10^26 FLOP训练门槛的受覆盖模型在十五天内报告安全事件[2]。SB 53适用于使用超过10^26次计算操作训练的前沿模型开发者，最严格的义务落在年总收入超过5亿美元的大型前沿开发者身上[5]。民事罚款最高可达每次违规100万美元，具体取决于严重程度[5]。在伊利诺伊州，年收入超过5亿美元的大型前沿开发者必须从2028年1月1日起聘请独立第三方进行年度审计[3]。科罗拉多州的SB 26-189法案自2027年1月1日起生效，要求在重大决策中使用的自动化决策技术的开发者和部署者在作出不利决定后向消费者提供通知和解释[5]。

在联邦层面，2026年《人工智能基础模型透明度法案》（H.R. 8094）将指示联邦贸易委员会为高影响基础模型制定披露标准，但并未建立许可权限[2]。《先进人工智能安全准备法案》（H.R. 3919）指示国家安全局局长制定《人工智能安全手册》，但明确表示该法案不授权对人工智能公司采取监管或执法行动[2]。

在英国，相关说明未指明正式的法定许可门槛。英国人工智能安全研究所在Anthropic发布Claude Mythos后六天内发布了独立的网络能力评估结果，发现Mythos是首个完成32步模拟网络攻击演练的人工智能[2]。部长们还确认，《网络安全与韧性法案》将重新提交议会审议，以应对人工智能辅助的网络威胁[2]。

## 2026年，各国政府如何执行AI模型的训练数据透明度要求？

加利福尼亚州的AB 2013法案于2026年1月1日生效，是美国一项核心的训练数据透明度措施[6]。该法案要求生成式AI系统的开发者公开披露用于训练其模型的详细数据信息，包括数据集来源、数据类型、是否使用了受版权保护的材料，以及是否包含个人信息[6]。开发者必须在其网站上发布一份涵盖12个指定类别的高层级摘要，包括数据集的来源或所有者，以及系统在开发过程中是否使用或持续使用合成数据生成技术[9]。

在执行方面，AB 2013并未明确规定执行机制或处罚措施，但可根据加利福尼亚州的《不正当竞争法》予以执行[12]。2026年3月4日，一家联邦地区法院驳回了xAI针对AB 2013提出的初步禁令动议，允许该法律继续生效[8]。OpenAI和Anthropic已根据该法律发布了披露信息，但这些信息仍停留在高层级，并未指明用于训练其模型的具体数据集[11]。加利福尼亚州的AI透明度框架由四项独立的法律文书组成：SB 942、AB 2013、SB 53以及CPPA ADMT法规，每项文书的适用范围和生效日期各不相同[10]。

加利福尼亚州的SB 942法案（经AB 853修订）要求月活跃加利福尼亚用户超过100万的受覆盖生成式AI提供商在AI生成的图像、视频和音频中嵌入符合C2PA标准的潜在来源水印，并提供免费的公开检测工具；其生效日期已从2026年1月1日推迟至2026年8月2日，以与欧盟《AI法案》第50条的时间表保持一致[13]。

在联邦层面，《TRAIN法案》于2026年1月22日提出，该法案将赋予版权持有人访问AI训练数据的权利，使其能够核实其作品是否在未经授权的情况下被使用；该法案将允许版权持有人在未经事先司法审查的情况下传唤AI训练数据[7]。2025年12月11日的一项行政命令表明，联邦政府有意整合AI监管职能，并对繁重的州级AI规则提出挑战，但该命令并未优先于、暂停或废止当前及已颁布的州级AI法律[15]。

在欧盟，《AI法案》第50条要求对聊天机器人进行披露，并对合成内容进行标注，相关执法自2026年8月2日起启动[14]。科罗拉多州最初的《AI法案》SB 24-205原定于2026年6月30日生效，但在xAI诉Weiser案之后，执法工作被暂停；科罗拉多州立法者已推进SB 26-189作为替代框架，该框架聚焦于自动化决策技术，若获通过，主要义务将于2027年1月1日起生效[14]。

## 2026年存在哪些跨境AI评估协议，它们是如何实施的？

主要的 multilateral 机制是国际先进AI测量、评估与科学网络，前身为国际AI安全研究所网络，成员包括澳大利亚、加拿大、欧盟、法国、日本、肯尼亚、韩国、新加坡、英国和美国[16]。2025年，网络成员在圣地亚哥与NeurIPS同期举行会议，就评估最佳实践达成共识[16]。成员们已确定共识领域，包括评估需要明确目标、透明性和可复现性、质量保证、独立报告、可理解的主要结论、增强有效性，以及考虑不同语言和文化[16]。关于评估是否应使用风险模型、评估者应优先考虑什么、应共享哪些信息、报告模板应有多灵活，以及如何测试AI系统而不仅仅是模型，仍存在开放性问题[16]。作为2026年的网络协调方，英国将在今年晚些时候牵头将共享学习转化为更详细的best-practice文档[16]。

在双边层面，澳大利亚和加拿大于2026年初签署了AI安全合作协议，以通过国际AI安全研究所网络加强AI安全合作[17]。澳大利亚和英国于2026年5月下旬签署了一份谅解备忘录，根据该备忘录，澳大利亚AI安全研究所和英国AI安全研究所将合作共享新兴AI能力和风险的信息与专业知识、测试AI系统的最佳实践、开展联合研究，并支持国际先进AI测量、评估与科学网络[17]。

《2026年国际AI安全报告》于2026年2月发布，由Yoshua Bengio牵头，100多位AI专家撰写，得到30多个国家和国际组织的支持[18]。该报告聚焦于AI能力前沿出现的“新兴风险”，并将在印度AI影响峰会上展示[18]。

2026年5月5日，Google DeepMind、Microsoft和xAI与美国AI标准与创新中心（CAISI）签署协议，为其前沿AI模型提供部署前测试的早期访问权限[20]。这些协议使参与CAISI部署前审查计划的前沿实验室总数达到五家，OpenAI和Anthropic此前已建立合作伙伴关系[20]。CAISI已完成40多项评估，包括对尚未向公众开放的前沿模型的评估[20]。其开展评估的权力完全依赖于自愿参与，因为该中心只能评估开发者选择共享的模型[20]。2026年3月，CAISI与美国总务管理局正式签署了一份谅解备忘录，将其评估方法通过USAi安全生成式AI平台扩展到联邦AI采购[20]。其职责包括评估前沿AI在网络作战、生物安全、化学和生物威胁领域以及操纵能力方面的能力[20]。CAISI已发布DeepSeek V4 Pro的评估结果[20]。

Microsoft于2026年5月5日宣布与CAISI和英国AI安全研究所达成协议[21]。与CAISI的合作包括改进对抗性评估方法，以及共同开发系统化、可复现的评估方法[21]。与英国AISI的合作涵盖前沿安全和安保研究，包括评估高风险能力和保障措施的方法，以及社会韧性研究[21]。Microsoft还通过国际AI测量、评估与科学网络与全球其他AI研究所开展研究和评估，并为MLCommons做出贡献，包括努力扩展AILuminate以支持多语言、多文化和多模态评估[21]。

欧盟计划发起一项倡议，以增强对进入欧盟市场前的AI模型的欧盟评估能力，预计将于2027年投入运行[19]。一份已发布的报告还指出，白宫即将准备一项行政命令，为所有新AI模型建立审查系统[22]。

## 2026年，各主要监管路径在进展和执行方面有何比较？

三条监管路径在法律效力和执行成熟度方面差异显著[19][20][33]。

在前沿模型许可门槛方面，欧盟路径最具约束力。《欧盟人工智能法案》对具有系统性风险的通才型人工智能施加义务，包括训练计算量超过10^25 FLOP的模型[1]。治理和执行条款自2026年8月2日起适用，人工智能办公室对GPAI模型拥有执行权力[19]。然而，欧盟的高风险义务已被推迟：独立的附件III系统从2026年8月2日推迟至2027年12月2日[3][26]。美国没有联邦许可制度，第14409号行政命令明确否认强制性许可、预先批准或审批要求[4]。加利福尼亚州SB 53等州级措施施加的是披露和报告义务，而非发布前批准，尽管存在民事处罚[2][5]。白宫对Claude Mythos Preview的非正式否决说明了在法定许可框架之外行使的行政压力[2]。

在训练数据透明度方面，加利福尼亚州AB 2013是美国最具可操作性的措施：该法案已生效，经受住了初步禁令挑战，并已产生高层级披露，但缺乏明确的处罚规定[6][8][11][12]。欧盟第50条透明度义务于2026年8月生效，违反透明度规定的处罚最高可达1500万欧元或全球年营业额的3%[3][14]。在美国联邦层面，《TRAIN法案》仍是一项拟议法案，而非已颁布的法律[7]。2025年12月的联邦行政命令表明了对州级规则的抵制倾向，但并未立即使其失效[15]。

在跨境评估方面，进展具有可操作性但基本属于自愿性质。国际网络已形成共识领域和开放性问题，而非可执行的标准[16]。澳大利亚-加拿大和澳大利亚-英国安排等双边协议属于合作文书[17]。《2026年国际人工智能安全报告》提供了共享的科学证据基础，但其本身并不创设法律义务[18]。CAISI的部署前评估完全基于开发者的自愿参与[20]。微软与CAISI及英国人工智能安全研究所的协议体现了该路径的自愿、伙伴关系性质[21]。

在所有路径中，《欧盟人工智能法案》仍是具有约束力的、按风险分层的全球最高标准人工智能合规基准，大多数义务已于2026年生效[28][33]。2026年美国联邦层面的立场倾向于轻触式、创新优先的监管，并积极推动优先于州级人工智能法律，但优先权问题仍存在争议且尚未解决[33]。州级立法活动十分密集：截至2026年3月，45个州的立法者已提出1,561项人工智能相关法案[23]，截至2026年7月1日，各州已颁布109项人工智能法律[24]。联邦贸易委员会一直是联邦层面人工智能执法最活跃的机构，利用其在《联邦贸易委员会法》第5条下的现有权力，针对不公平或欺骗性人工智能行为采取行动[27]。在全球范围内，至少有72个国家提出了超过1,000项人工智能相关政策倡议和法律框架，但在大多数情况下，这些政策尚未转化为具有法律约束力的法规[30][35]。

## 未经证实

本报告不包含任何未经引用的事实性陈述。

## 局限 / 未覆盖

未跳过任何子问题。本报告仅限于所提供的笔记，并未纳入除直接引用或间接提及之外的主要立法文本。笔记本身属于二手资料，且存在一些矛盾之处；例如，一份资料称OpenAI和Anthropic于2025年9月建立了CAISI合作伙伴关系，而另一份资料则称它们于2024年8月签署了类似协议[20][22]。除所引示例之外，诸如AB 2013实际处罚决定或待决法案及行政行动的最终结果等执法成果，在所提供的材料中并未涉及。

## 参考文献

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
