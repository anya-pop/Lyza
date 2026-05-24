// guided-walkthrough.js — Orchestrates the embodied guided tour.
// Executes a plan = [{ tool, args, say, status, pause }] through LyzaHands.
// buildDemoPlan() inspects the page map and produces a sensible tour locally
// (no backend) — useful as a fallback and for the demo harness.
// Multilingual narration via the SAY catalog (en/hi/es/fr/zh/ar/pt + more).
(function () {
  if (window.LyzaWalkthrough) return;
  const eyes = () => window.LyzaEyes;
  const hands = () => window.LyzaHands;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Multilingual narration catalog ------------------------------------
  // Keys: en, es, hi, fr, pt, zh, ar, ko, vi, tl, ur — fallback to en.
  // Tooltips and status texts are short and shown in the SAME language so
  // hover-text and chip stay consistent with the spoken narration.
  const SAY = {
    en: {
      priceIntro:  "Let's look at this listing together. Here's the monthly rent.",
      priceConv:   "In your home currency that's about 148,000 rupees per month.",
      clauseWarn:  "Watch this clause. It asks for a non-refundable deposit before you can even see the apartment. That is a major red flag.",
      msgWarn:     "The landlord's message says they're abroad and want money before showing the place. Scammers use this story constantly.",
      goodPoint:   "To be fair, some terms are good — utilities are included, which saves you money.",
      finalReco:   "My recommendation: this listing is high risk. Never send a deposit before seeing the place in person.",
      tip: {
        clause:    "Demanding a non-refundable deposit before any viewing is a classic rental scam pattern.",
        msg:       "“I'm abroad, send money first, agent mails keys” is one of the most common rental-scam scripts.",
        good:      "Utilities included saves you money each month — a genuinely good term.",
        recoNote:  "High risk. Do not send any deposit before viewing in person."
      },
      status: {
        price:   "Reading the price",
        convert: "Converting the price",
        clause:  "Found a risky clause",
        msg:     "Screening the message",
        good:    "Noting the good parts",
        reco:    "Final recommendation",
        done:    "Walkthrough complete",
        stopped: "Stopped"
      }
    },
    es: {
      priceIntro:  "Miremos juntos este anuncio. Este es el alquiler mensual.",
      priceConv:   "En tu moneda local esto son aproximadamente 148.000 rupias al mes.",
      clauseWarn:  "Cuidado con esta cláusula. Pide un depósito no reembolsable antes incluso de visitar el departamento. Es una señal de alarma grande.",
      msgWarn:     "El mensaje del propietario dice que está en el extranjero y quiere dinero antes de mostrar el lugar. Los estafadores usan esta historia constantemente.",
      goodPoint:   "Para ser justos, algunas condiciones son buenas: los servicios están incluidos, lo cual te ahorra dinero.",
      finalReco:   "Mi recomendación: este anuncio es de alto riesgo. Nunca envíes un depósito sin ver el lugar en persona.",
      tip: {
        clause:    "Exigir un depósito no reembolsable antes de cualquier visita es un patrón clásico de estafa de alquiler.",
        msg:       "“Estoy en el extranjero, envía dinero primero, mi agente te enviará las llaves” es uno de los guiones de estafa de alquiler más comunes.",
        good:      "Servicios incluidos te ahorra dinero cada mes — una condición genuinamente buena.",
        recoNote:  "Alto riesgo. No envíes ningún depósito sin ver el lugar en persona."
      },
      status: {
        price:   "Leyendo el precio",
        convert: "Convirtiendo el precio",
        clause:  "Cláusula riesgosa detectada",
        msg:     "Revisando el mensaje",
        good:    "Notando lo bueno",
        reco:    "Recomendación final",
        done:    "Recorrido completo",
        stopped: "Detenido"
      }
    },
    hi: {
      priceIntro:  "चलो इस listing को साथ में देखते हैं। यह monthly किराया है।",
      priceConv:   "आपकी home currency में यह लगभग एक लाख अड़तालीस हज़ार रुपये प्रति महीना है।",
      clauseWarn:  "इस clause को देखिए। यह apartment देखने से पहले ही non-refundable deposit मांग रहा है। यह एक बहुत बड़ा red flag है।",
      msgWarn:     "Landlord का message कहता है कि वे विदेश में हैं और जगह दिखाने से पहले पैसे चाहते हैं। Scammers यही कहानी बार-बार इस्तेमाल करते हैं।",
      goodPoint:   "सच कहूँ तो कुछ terms अच्छी हैं — utilities included हैं, जिससे आपका हर महीने पैसा बचेगा।",
      finalReco:   "मेरी सलाह: यह listing high risk है। जगह को व्यक्तिगत रूप से देखे बिना कभी भी deposit मत भेजिए।",
      tip: {
        clause:    "Viewing से पहले non-refundable deposit माँगना rental scam का classic pattern है।",
        msg:       "“मैं विदेश में हूँ, पहले पैसे भेजो, agent keys मेल करेगा” — यह सबसे common rental scam script है।",
        good:      "Utilities included होने से हर महीने पैसा बचता है — यह genuinely अच्छी term है।",
        recoNote:  "High risk. व्यक्तिगत रूप से देखे बिना कोई deposit मत भेजिए।"
      },
      status: {
        price:   "Price पढ़ रही हूँ",
        convert: "Price convert कर रही हूँ",
        clause:  "Risky clause मिली",
        msg:     "Message check कर रही हूँ",
        good:    "अच्छी बातें note कर रही हूँ",
        reco:    "Final सलाह",
        done:    "Walkthrough पूरा",
        stopped: "रोक दिया"
      }
    },
    fr: {
      priceIntro:  "Regardons cette annonce ensemble. Voici le loyer mensuel.",
      priceConv:   "Dans votre devise d'origine, cela représente environ 148 000 roupies par mois.",
      clauseWarn:  "Attention à cette clause. Elle demande un dépôt non remboursable avant même que vous puissiez voir l'appartement. C'est un signal d'alarme majeur.",
      msgWarn:     "Le message du propriétaire dit qu'il est à l'étranger et veut de l'argent avant de montrer le logement. Les escrocs utilisent constamment cette histoire.",
      goodPoint:   "Pour être juste, certaines conditions sont bonnes — les charges sont incluses, ce qui vous fait économiser de l'argent.",
      finalReco:   "Ma recommandation : cette annonce est à haut risque. N'envoyez jamais de dépôt sans visiter le logement en personne.",
      tip: {
        clause:    "Exiger un dépôt non remboursable avant toute visite est un schéma classique d'arnaque locative.",
        msg:       "« Je suis à l'étranger, envoyez d'abord l'argent, mon agent enverra les clés » est l'un des scripts d'arnaque les plus courants.",
        good:      "Charges incluses vous fait économiser chaque mois — une condition vraiment bonne.",
        recoNote:  "Haut risque. N'envoyez aucun dépôt avant une visite en personne."
      },
      status: {
        price:   "Lecture du prix",
        convert: "Conversion du prix",
        clause:  "Clause risquée détectée",
        msg:     "Analyse du message",
        good:    "Points positifs",
        reco:    "Recommandation finale",
        done:    "Visite terminée",
        stopped: "Arrêté"
      }
    },
    pt: {
      priceIntro:  "Vamos ver este anúncio juntos. Este é o aluguel mensal.",
      priceConv:   "Na sua moeda local isto é cerca de 148 mil rupias por mês.",
      clauseWarn:  "Cuidado com esta cláusula. Ela exige um depósito não-reembolsável antes mesmo de ver o apartamento. É um grande alerta vermelho.",
      msgWarn:     "A mensagem do proprietário diz que ele está no exterior e quer dinheiro antes de mostrar o lugar. Golpistas usam essa história constantemente.",
      goodPoint:   "Para ser justo, algumas condições são boas — contas incluídas, o que economiza dinheiro.",
      finalReco:   "Minha recomendação: este anúncio é de alto risco. Nunca envie depósito sem ver o lugar pessoalmente.",
      tip: {
        clause:    "Exigir depósito não-reembolsável antes de qualquer visita é um padrão clássico de golpe de aluguel.",
        msg:       "“Estou no exterior, mande dinheiro primeiro, meu agente envia as chaves” é um dos roteiros de golpe mais comuns.",
        good:      "Contas incluídas economiza dinheiro todo mês — uma condição genuinamente boa.",
        recoNote:  "Alto risco. Não envie depósito sem visita pessoal."
      },
      status: {
        price:   "Lendo o preço",
        convert: "Convertendo o preço",
        clause:  "Cláusula arriscada",
        msg:     "Analisando a mensagem",
        good:    "Pontos positivos",
        reco:    "Recomendação final",
        done:    "Tour completo",
        stopped: "Parado"
      }
    },
    zh: {
      priceIntro:  "我们一起看看这则房源信息。这是每月租金。",
      priceConv:   "换算成您的本国货币,大约是每月14万8千卢比。",
      clauseWarn:  "注意这个条款。它要求在看房之前就支付不可退还的押金。这是一个重大的危险信号。",
      msgWarn:     "房东的消息说他在国外,想在看房之前先收钱。骗子经常使用这种说辞。",
      goodPoint:   "公平地说,有些条款是好的——水电费包含在内,可以为您节省开支。",
      finalReco:   "我的建议:这则房源风险很高。在亲自看房之前,千万不要付押金。",
      tip: {
        clause:    "看房前要求不可退还押金是典型的租房诈骗模式。",
        msg:       "“我在国外,先打钱,经纪人会寄钥匙”是最常见的租房诈骗剧本之一。",
        good:      "水电费包含每月节省开支——这是真正的好条款。",
        recoNote:  "高风险。亲自看房之前不要支付任何押金。"
      },
      status: {
        price:   "正在读取价格",
        convert: "正在转换价格",
        clause:  "发现风险条款",
        msg:     "正在筛查消息",
        good:    "记下亮点",
        reco:    "最终建议",
        done:    "导览完成",
        stopped: "已停止"
      }
    },
    ar: {
      priceIntro:  "لنلقِ نظرة على هذا الإعلان معًا. هذا هو الإيجار الشهري.",
      priceConv:   "بعملتك الأصلية، يبلغ ذلك حوالي مئة وثمانية وأربعين ألف روبية شهريًا.",
      clauseWarn:  "انتبه لهذا البند. إنه يطلب وديعة غير قابلة للاسترداد قبل حتى أن ترى الشقة. هذه علامة خطر كبيرة.",
      msgWarn:     "رسالة المالك تقول إنه في الخارج ويريد المال قبل عرض المكان. المحتالون يستخدمون هذه القصة باستمرار.",
      goodPoint:   "للإنصاف، بعض الشروط جيدة — المرافق مشمولة، مما يوفر لك المال.",
      finalReco:   "توصيتي: هذا الإعلان عالي الخطورة. لا ترسل وديعة أبدًا قبل رؤية المكان شخصيًا.",
      tip: {
        clause:    "طلب وديعة غير قابلة للاسترداد قبل أي معاينة هو نمط احتيال إيجار كلاسيكي.",
        msg:       "“أنا في الخارج، أرسل المال أولاً، الوكيل سيرسل المفاتيح” من أكثر سيناريوهات الاحتيال شيوعًا.",
        good:      "المرافق مشمولة توفر لك المال كل شهر — شرط جيد بالفعل.",
        recoNote:  "خطر عالٍ. لا ترسل أي وديعة قبل المعاينة الشخصية."
      },
      status: {
        price:   "قراءة السعر",
        convert: "تحويل السعر",
        clause:  "بند خطر",
        msg:     "فحص الرسالة",
        good:    "النقاط الجيدة",
        reco:    "التوصية النهائية",
        done:    "اكتمل الجولة",
        stopped: "تم الإيقاف"
      }
    }
  };

  function L(lang) { return SAY[lang] || SAY.en; }

  async function run(plan, opts = {}) {
    const onNarrate = opts.onNarrate || (() => {});
    const h = hands();
    h.begin();
    try {
      for (let i = 0; i < plan.length; i++) {
        if (h.halted) break;
        const step = plan[i];
        h.setStatus(step.status || `Step ${i + 1} of ${plan.length}`);
        if (step.say) onNarrate(step.say);
        const fn = h[step.tool];
        if (typeof fn === "function") await fn(step.args || {});
        await sleep(step.pause != null ? step.pause : 900);
      }
      if (!h.halted) {
        h.setStatus("Walkthrough complete");
        if (typeof h.celebrate === "function") h.celebrate();
      }
    } catch (e) {
      if (String(e.message).includes("LYZA_HALTED")) h.setStatus("Stopped");
      else { console.error("[Lyza] walkthrough error", e); h.setStatus("Something went wrong"); }
    }
    return { halted: h.halted };
  }

  function findByText(map, re) { return map.filter((e) => re.test(e.text || "")); }

  function buildDemoPlan(opts = {}) {
    const lang = (opts.language || "en").toLowerCase();
    const t = L(lang);
    const homeBadge = opts.homeBadge || "≈ ₹148,000 / month · live rate";
    const map = eyes().buildMap();
    const steps = [];

    const price = map.find((e) => e.role === "price") || findByText(map, /(?:CA\$|\$)\s?\d/)[0];
    if (price) {
      steps.push({
        tool: "scroll_to", args: { id: price.id },
        say: t.priceIntro,
        status: t.status.price, pause: 700
      });
      steps.push({
        tool: "inject_badge", args: { id: price.id, text: homeBadge, tone: "accent" },
        say: t.priceConv,
        status: t.status.convert, pause: 1100
      });
    }

    const clause = map.find((e) => /non-refundable|retained by the landlord|before any viewing/i.test(e.text || ""))
      || map.find((e) => /deposit/i.test(e.text || "") && (e.text || "").length > 60);
    if (clause) {
      steps.push({
        tool: "highlight",
        args: { id: clause.id, style: "danger", reason: t.tip.clause },
        say: t.clauseWarn,
        status: t.status.clause, pause: 1400
      });
    }

    const sellerMsg = map.find((e) => /working abroad|cannot show|mail you the keys|e-?transfer today/i.test(e.text || ""));
    if (sellerMsg) {
      steps.push({
        tool: "highlight",
        args: { id: sellerMsg.id, style: "warn", reason: t.tip.msg },
        say: t.msgWarn,
        status: t.status.msg, pause: 1400
      });
    }

    const good = map.find((e) => /utilities included/i.test(e.text || ""))
      || map.find((e) => /furnished|available immediately/i.test(e.text || ""));
    if (good) {
      steps.push({
        tool: "highlight",
        args: { id: good.id, style: "good", reason: t.tip.good },
        say: t.goodPoint,
        status: t.status.good, pause: 1200
      });
    }

    if (price) {
      steps.push({
        tool: "annotate",
        args: { id: price.id, note: t.tip.recoNote },
        say: t.finalReco,
        status: t.status.reco, pause: 1000
      });
    }

    return steps;
  }

  window.LyzaWalkthrough = { run, buildDemoPlan, SAY, L };
})();
