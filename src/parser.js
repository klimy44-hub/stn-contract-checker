/*
 * Rule-based extraction of supply-contract terms from Russian TXT documents.
 * Works in the browser (window.STN) and in Node (module.exports).
 * Nothing here knows specific file names, numbers or values: everything is read from text.
 */
(function (root) {
  'use strict';

  const MONTHS = {
    января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
    июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
  };
  const CYR = 'А-Яа-яЁё';
  const DATE_RE = new RegExp(
    '(\\d{1,2})\\s+(' + Object.keys(MONTHS).join('|') + ')\\s+(\\d{4})|(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})',
    'gi'
  );
  const MONEY_RE = /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{2}))?\s*(?:\([^)]*\)\s*)?(?:руб|₽)/gi;
  // Contract number: uppercase letters + digits, e.g. STN-101, АБ-12/3.
  const ID = '([A-ZА-ЯЁ]{2,}[-/]?\\d+(?:[-/]\\d+)*)';
  const AMOUNT_KEY = /(сумм|цен|стоимост)[а-яёa-z]*\s+(?:настоящего\s+)?договора|(общ|итогов)[а-яёa-z]*\s+стоимост/i;
  // Sentences about other money: they are never the contract amount.
  const AMOUNT_EXCLUDE = /аванс|лимит|бюджет|неустойк|штраф|оставш/i;
  const DELIVERY_KEY = /срок[а-яёa-z]*\s+поставки|поставить|поставк[а-яёa-z]+\s+(?:товара\s+)?(?:осуществля|производ|должна)/i;
  // Sentences about payment/acceptance dates: they are never the delivery term.
  const DELIVERY_EXCLUDE = /оплат|приемк|приёмк/i;
  const RELATIVE_TERM = /в\s+течение\s+\d+/i;
  // A candidate value right after these words is the OLD value in an amendment ("вместо X", "с X на Y").
  const OLD_VALUE_PREFIX = /(вместо|с)\s*$/i;
  const VAT_PREFIX = /НДС[^,;]{0,15}$/i;

  const pad = (n) => String(n).padStart(2, '0');

  function findDates(text) {
    const out = [];
    for (const m of text.matchAll(DATE_RE)) {
      const [d, mo, y] = m[1]
        ? [+m[1], MONTHS[m[2].toLowerCase()], +m[3]]
        : [+m[4], +m[5], +m[6]];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        out.push({ iso: `${y}-${pad(mo)}-${pad(d)}`, index: m.index, raw: m[0] });
      }
    }
    return out;
  }

  function findMoney(text) {
    return [...text.matchAll(MONEY_RE)].map((m) => ({
      value: Number(m[1].replace(/[  ]/g, '') + (m[2] ? '.' + m[2] : '')),
      index: m.index,
      raw: m[0],
    }));
  }

  /** Split a paragraph into sentences; "1.1." clause numbers are not sentence ends. */
  function toSentences(text) {
    return text.split(/(?<=[^\d][.!?]»?)\s+(?=[«A-ZА-ЯЁ])/).filter(Boolean);
  }

  function toParagraphs(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t, i) => ({ n: i + 1, text: t }));
  }

  /** Contracts state the value first; amendments may mention the old value, so take the last "new" one. */
  function pickCandidate(text, candidates, isAmendment) {
    const usable = candidates.filter((c) => {
      const before = text.slice(0, c.index);
      return !VAT_PREFIX.test(before.slice(-30)) && !(isAmendment && OLD_VALUE_PREFIX.test(before));
    });
    if (!usable.length) return null;
    return isAmendment ? usable[usable.length - 1] : usable[0];
  }

  /**
   * Extract one field. Returns {value, source, note} where value is null if absent.
   * source = {paragraph, quote} pointing at the exact line used.
   */
  function extractField(paragraphs, field, isAmendment) {
    const key = field === 'amount' ? AMOUNT_KEY : DELIVERY_KEY;
    const exclude = field === 'amount' ? AMOUNT_EXCLUDE : DELIVERY_EXCLUDE;
    const finder = field === 'amount' ? findMoney : findDates;
    let mentionWithoutValue = null;
    for (const p of paragraphs) {
      for (const sentence of toSentences(p.text)) {
        if (!key.test(sentence) || exclude.test(sentence)) continue;
        const picked = pickCandidate(sentence, finder(sentence), isAmendment);
        if (picked) {
          return { value: field === 'amount' ? picked.value : picked.iso, source: { paragraph: p.n, quote: sentence } };
        }
        // Keep the first clause that talks about the field but has no concrete value (headings are skipped).
        if (!mentionWithoutValue && /[а-яё]/.test(sentence) && (field === 'amount' || RELATIVE_TERM.test(sentence))) {
          mentionWithoutValue = { paragraph: p.n, quote: sentence };
        }
      }
    }
    if (mentionWithoutValue) {
      return {
        value: null,
        source: mentionWithoutValue,
        note: field === 'amount'
          ? 'Сумма не указана числом — нет данных'
          : 'Срок указан относительно события, без календарной даты — нет данных',
      };
    }
    return { value: null, source: null, note: 'Условие в тексте не найдено' };
  }

  function detectType(paragraphs, text) {
    // The title (first two lines) defines the type; body text may mention other document kinds.
    const head = paragraphs.slice(0, 2).map((p) => p.text).join(' ');
    if (/(^|\s)(исх\.|письм)/i.test(head) || /^(От|Тема):/m.test(text) || /уважаем/i.test(text)) return 'letter';
    if (/дополнительн[а-яёa-z]*\s+соглашени/i.test(head)) return 'addendum';
    if (/договор/i.test(head)) return 'contract';
    return 'unknown';
  }

  function detectSignature(text) {
    // An explicit "Статус:" line wins over heuristics.
    const status = (text.match(/^Статус:\s*(.+)$/im) || [])[1];
    if (status) {
      if (/не\s+подписан|проект/i.test(status)) return 'draft';
      if (/подписан[а-яёa-z]*\s+(обеими\s+)?сторонами/i.test(status)) return 'signed';
    }
    const isDraft = new RegExp(`(^|[^${CYR}])ПРОЕКТ([^${CYR}]|$)`).test(text) || /не\s+подписан/i.test(text);
    if (isDraft) return 'draft';
    const signatureMarks = text.match(new RegExp(`/[${CYR}]+\\s+[А-ЯЁ]\\.\\s?[А-ЯЁ]\\./`, 'g')) || [];
    if (/подписан[оаы]?\s+(обеими\s+)?сторонами/i.test(text) || signatureMarks.length >= 2) return 'signed';
    return 'unknown';
  }

  function detectContractRefs(paragraphs, type) {
    const re = new RegExp(`договор[а-яёa-z]*[^.\\n]{0,40}?${ID}`, 'gi');
    const scope = type === 'contract' ? paragraphs.slice(0, 3) : paragraphs;
    const refs = new Set();
    for (const p of scope) for (const m of p.text.matchAll(re)) refs.add(m[1]);
    return [...refs];
  }

  function detectSupplier(paragraphs) {
    const named = /((?:ООО|АО|ПАО|ЗАО|ИП)\s*«[^»]+»)[^.«]{0,120}?(?:именуем[а-яёa-z]*\s+(?:в\s+дальнейшем\s+)?)?«Поставщик»/;
    for (const p of paragraphs) {
      const m = p.text.match(named) || p.text.match(/Поставщик:\s*((?:ООО|АО|ПАО|ЗАО|ИП)\s*«[^»]+»)/);
      if (m) return { value: m[1], source: { paragraph: p.n, quote: p.text } };
    }
    return { value: null, source: null, note: 'Поставщик не найден' };
  }

  function detectEffectiveDate(paragraphs) {
    const effective = paragraphs.find((p) => /вступает\s+в\s+силу/i.test(p.text));
    if (effective) {
      const d = findDates(effective.text)[0];
      if (d) return { value: d.iso, source: { paragraph: effective.n, quote: effective.text } };
    }
    // "с момента подписания" → date of signing in header ("г. Город ... дата").
    const header = paragraphs.find((p) => /^(г\.\s|Дата)/.test(p.text) && findDates(p.text).length);
    if (effective && /подписани/i.test(effective.text) && header) {
      return {
        value: findDates(header.text)[0].iso,
        source: { paragraph: header.n, quote: header.text },
        note: 'Дата вступления в силу = дата документа (с момента подписания)',
      };
    }
    return { value: null, source: effective ? { paragraph: effective.n, quote: effective.text } : null };
  }

  function analyzeDocument(fileName, text) {
    const paragraphs = toParagraphs(text);
    const type = detectType(paragraphs, text);
    const isAmendment = type !== 'contract';
    const refs = detectContractRefs(paragraphs, type);
    return {
      fileName,
      paragraphs,
      type,
      signature: detectSignature(text),
      contractRefs: refs,
      supplier: type === 'contract' ? detectSupplier(paragraphs) : null,
      effectiveDate: type === 'addendum' ? detectEffectiveDate(paragraphs) : null,
      amount: extractField(paragraphs, 'amount', isAmendment),
      delivery: extractField(paragraphs, 'delivery', isAmendment),
    };
  }

  /** Status of a non-contract document relative to the check date. */
  function documentStatus(doc, checkDate) {
    if (doc.type === 'letter') return { code: 'proposal', label: 'Письмо — предложение, не изменяет условия' };
    if (doc.type !== 'addendum') return { code: 'unknown', label: 'Тип документа не распознан — требуется проверка' };
    if (doc.signature === 'draft') return { code: 'draft', label: 'Проект / не подписан — не изменяет условия' };
    if (doc.signature !== 'signed') return { code: 'unknown', label: 'Не удалось установить, подписано ли допсоглашение — требуется проверка' };
    const eff = doc.effectiveDate && doc.effectiveDate.value;
    if (!eff) return { code: 'unknown', label: 'Подписано, но дата вступления в силу не найдена — требуется проверка' };
    if (eff > checkDate) return { code: 'not_effective', label: `Подписано, вступает в силу ${eff} — после даты проверки` };
    return { code: 'applied', label: `Подписано, действует с ${eff}` };
  }

  const FIELDS = ['amount', 'delivery'];

  function withFile(fieldResult, fileName) {
    return { ...fieldResult, source: fieldResult.source ? { file: fileName, ...fieldResult.source } : null };
  }

  function buildContractView(contract, related, checkDate) {
    const issues = [];
    const fields = {};
    for (const f of FIELDS) fields[f] = { ...withFile(contract[f], contract.fileName), changedBy: null, history: [] };

    const withStatus = related.map((doc) => ({ doc, status: documentStatus(doc, checkDate) }));
    const applied = withStatus
      .filter((x) => x.status.code === 'applied')
      .sort((a, b) => a.doc.effectiveDate.value.localeCompare(b.doc.effectiveDate.value));

    for (const f of FIELDS) {
      const changes = applied.filter((x) => x.doc[f].value !== null);
      for (const { doc } of changes) {
        fields[f].history.push({ ...withFile(fields[f], fields[f].source && fields[f].source.file) });
        fields[f] = { ...withFile(doc[f], doc.fileName), changedBy: doc.fileName, history: fields[f].history };
      }
      const last = changes[changes.length - 1];
      const clash = last && changes.some((x) => x !== last
        && x.doc.effectiveDate.value === last.doc.effectiveDate.value && x.doc[f].value !== last.doc[f].value);
      if (clash) issues.push(`Несколько допсоглашений с одной датой вступления в силу по-разному меняют поле «${f === 'amount' ? 'сумма' : 'срок'}»`);
    }

    const pending = [];
    for (const { doc, status } of withStatus) {
      if (status.code === 'applied') continue;
      const proposed = FIELDS.filter((f) => doc[f].value !== null)
        .map((f) => ({ field: f, ...withFile(doc[f], doc.fileName) }));
      if (status.code === 'unknown') issues.push(`${doc.fileName}: ${status.label}`);
      pending.push({ fileName: doc.fileName, status, proposed });
    }

    for (const f of FIELDS) if (fields[f].value === null) issues.push(`${f === 'amount' ? 'Сумма' : 'Срок поставки'}: ${fields[f].note}`);

    return {
      number: contract.contractRefs[0],
      fileName: contract.fileName,
      supplier: withFile(contract.supplier, contract.fileName),
      amount: fields.amount,
      delivery: fields.delivery,
      related: withStatus.map(({ doc, status }) => ({ fileName: doc.fileName, status })),
      pending,
      issues,
    };
  }

  /** Build the contract registry for all uploaded documents as of checkDate (YYYY-MM-DD). */
  function buildRegistry(files, checkDate) {
    const docs = files.map((f) => analyzeDocument(f.name, f.text));
    const contracts = docs.filter((d) => d.type === 'contract' && d.contractRefs.length);
    const byNumber = new Map();
    for (const c of contracts) byNumber.set(c.contractRefs[0], [...(byNumber.get(c.contractRefs[0]) || []), c]);

    const unlinked = [];
    const relatedByNumber = new Map();
    for (const d of docs) {
      if (d.type === 'contract' && d.contractRefs.length) continue;
      const known = d.contractRefs.filter((r) => byNumber.has(r));
      if (known.length !== 1) {
        unlinked.push({
          fileName: d.fileName,
          reason: known.length > 1 ? `Ссылается на несколько договоров: ${known.join(', ')}` : 'Не удалось привязать к загруженному договору',
        });
        continue;
      }
      relatedByNumber.set(known[0], [...(relatedByNumber.get(known[0]) || []), d]);
    }

    const rows = [...byNumber.entries()].map(([num, list]) => {
      const view = buildContractView(list[0], relatedByNumber.get(num) || [], checkDate);
      if (list[0].signature !== 'signed') view.issues.push(`Не подтверждено, что договор ${num} подписан — требуется проверка`);
      if (list.length > 1) view.issues.push(`Загружено несколько договоров с номером ${num}: ${list.map((c) => c.fileName).join(', ')}`);
      return view;
    }).sort((a, b) => a.number.localeCompare(b.number));

    return { checkDate, docs, rows, unlinked };
  }

  /** Contracts with effective delivery date strictly before `date`, plus their unagreed delivery changes. */
  function deliveriesBefore(registry, date) {
    return registry.rows
      .filter((r) => r.delivery.value !== null && r.delivery.value < date)
      .map((r) => ({ row: r, unagreed: r.pending.flatMap((p) => p.proposed.filter((x) => x.field === 'delivery').map((x) => ({ ...x, status: p.status }))) }));
  }

  const api = { analyzeDocument, buildRegistry, deliveriesBefore, documentStatus, findDates, findMoney };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.STN = api;
})(typeof window !== 'undefined' ? window : globalThis);
