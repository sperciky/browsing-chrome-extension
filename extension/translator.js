// translator.js
// Local Russian → English translation using a curated dictionary + transliteration fallback.
// No external API calls.
// Wrapped in an idempotency guard so re-injection does not throw "already declared".

if (!window.YandexPDFTranslator) {
  window.YandexPDFTranslator = (() => {

    const WORD_DICTIONARY = {
      // Food & culinary
      "джандуйя": "gianduja",
      "из": "from",
      "пекана": "pecan",
      "пекан": "pecan",
      "шоколад": "chocolate",
      "ореховый": "nut",
      "ореховая": "nut",
      "масло": "butter",
      "сливки": "cream",
      "сахар": "sugar",
      "мёд": "honey",
      "мед": "honey",
      "молоко": "milk",
      "соль": "salt",
      "мука": "flour",
      "яйцо": "egg",
      "яйца": "eggs",
      "ваниль": "vanilla",
      "корица": "cinnamon",
      "карамель": "caramel",
      "торт": "cake",
      "пирог": "pie",
      "пирожное": "pastry",
      "крем": "cream",
      "глазурь": "glaze",
      "начинка": "filling",
      "тесто": "dough",
      "рецепт": "recipe",
      "рецепты": "recipes",
      "выпечка": "baking",
      "десерт": "dessert",
      "сладкий": "sweet",
      "горький": "bitter",
      "молочный": "milk",
      // Common words
      "и": "and",
      "в": "in",
      "на": "on",
      "с": "with",
      "для": "for",
      "от": "from",
      "до": "to",
      "по": "by",
      "при": "at",
      "без": "without",
      "под": "under",
      "над": "above",
      "не": "not",
      "или": "or",
      "но": "but",
      "как": "as",
      "что": "what",
      "это": "this",
      "все": "all",
      "так": "so",
      "уже": "already",
      "ещё": "also",
      "еще": "also",
      "очень": "very",
      "новый": "new",
      "новая": "new",
      "большой": "big",
      "маленький": "small",
      "хороший": "good",
      "первый": "first",
      "второй": "second",
      "один": "one",
      "два": "two",
      "три": "three",
      // Document types
      "документ": "document",
      "документы": "documents",
      "файл": "file",
      "отчет": "report",
      "отчёт": "report",
      "план": "plan",
      "список": "list",
      "таблица": "table",
      "схема": "scheme",
      "презентация": "presentation",
      "руководство": "guide",
      "инструкция": "instructions",
      "договор": "contract",
      "соглашение": "agreement",
      "акт": "act",
      "справка": "certificate",
      "письмо": "letter",
      "заявка": "request",
      "заявление": "statement",
      "протокол": "protocol",
      // Time
      "год": "year",
      "года": "year",
      "месяц": "month",
      "день": "day",
      "январь": "january",
      "февраль": "february",
      "март": "march",
      "апрель": "april",
      "май": "may",
      "июнь": "june",
      "июль": "july",
      "август": "august",
      "сентябрь": "september",
      "октябрь": "october",
      "ноябрь": "november",
      "декабрь": "december",
      // Colors
      "красный": "red",
      "синий": "blue",
      "зеленый": "green",
      "зелёный": "green",
      "белый": "white",
      "черный": "black",
      "чёрный": "black",
      "желтый": "yellow",
      "жёлтый": "yellow",
      "серый": "gray",
      "коричневый": "brown",
      "розовый": "pink",
      "оранжевый": "orange",
      "фиолетовый": "purple",
    };

    const TRANSLIT_MAP = {
      "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh","з":"z","и":"i",
      "й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t",
      "у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y",
      "ь":"","э":"e","ю":"yu","я":"ya",
      "А":"A","Б":"B","В":"V","Г":"G","Д":"D","Е":"E","Ё":"Yo","Ж":"Zh","З":"Z","И":"I",
      "Й":"Y","К":"K","Л":"L","М":"M","Н":"N","О":"O","П":"P","Р":"R","С":"S","Т":"T",
      "У":"U","Ф":"F","Х":"Kh","Ц":"Ts","Ч":"Ch","Ш":"Sh","Щ":"Shch","Ъ":"","Ы":"Y",
      "Ь":"","Э":"E","Ю":"Yu","Я":"Ya",
    };

    function transliterateWord(word) {
      return word.split("").map(ch => TRANSLIT_MAP[ch] !== undefined ? TRANSLIT_MAP[ch] : ch).join("");
    }

    function translateWord(word) {
      const lower = word.toLowerCase();
      if (WORD_DICTIONARY[lower]) {
        const t = WORD_DICTIONARY[lower];
        return (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase())
          ? t.charAt(0).toUpperCase() + t.slice(1)
          : t;
      }
      return transliterateWord(word);
    }

    function translateTitle(russianTitle) {
      let title = russianTitle.replace(/\.pdf$/i, "").trim();
      const tokens = title.split(/(\s+|[-_.,;:!?()[\]{}])/);
      const translated = tokens.map(token => {
        if (!token.trim()) return token;
        if (/[а-яёА-ЯЁ]/.test(token)) return translateWord(token);
        return token;
      });
      let result = translated.join("").replace(/\s+/g, " ").trim();
      result = result.replace(/\b\w/g, c => c.toUpperCase());
      const fillers = new Set(["from","and","in","with","on","by","for","at","or","of","the","a","an"]);
      return result.split(" ").map((w, i) => (i === 0 ? w : fillers.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(" ");
    }

    function sanitizeFilename(name) {
      return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "");
    }

    return { translateTitle, sanitizeFilename };
  })();
}
