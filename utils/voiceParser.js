// utils/voiceParser.js
const { wordsToNumbers } = require('words-to-numbers');

/* מילים עבריות → מספרים */
const heNumberMap = {
    'אחד': 1, 'אחת': 1,
    'שני': 2, 'שתי': 2, 'שתיים': 2, 'שניים': 2, 'שתים': 2, 'פעמיים': 2,
    'שלוש': 3, 'שלושה': 3,
    'ארבע': 4, 'ארבעה': 4,
    'חמש': 5, 'חמישה': 5,
    'שש': 6, 'שישה': 6,
    'שבע': 7, 'שבעה': 7, 'שיבעה': 7,
    'שמונה': 8,
    'תשע': 9, 'תשעה': 9, 'תישעה': 9,
    'עשר': 10, 'עשרה': 10
};

/* מילים אנגליות נפוצות → מספרים (למקרה שה-ASR נותן "three bananas") */
const enNumberMap = {
    'one': 1, 'a': 1, 'an': 1,
    'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10
};

/* מיפוי אותיות סופיות לרגילות */
const finalLettersMap = {
    'ם': 'מ',
    'ן': 'נ',
    'ף': 'פ',
    'ץ': 'צ',
    'ך': 'כ'
};

// מפה קטנה למקרים מיוחדים שלא מתאימים לדפוסים הגנריים
const specialCases = {
    'ק"ג': ['קילו', 'ק"ג'],
    'ביניים': ['ביניים', 'בינוני', 'בינונית'],
    'שקית': ['שקית', 'שקיות'],
    'שק': ['שק', 'שקי'],
    'מארז': ['מארז', 'מארזים', 'מארזי'],
    'סלסילה': ['סלסילה', 'סלסילות', 'סלסילת', 'סלסלה', 'סלסלות', 'סלסלת'],
    'מגש': ['מגש', 'מגשים', 'מגשי'],
    'יחידה': ['יחידה', 'יחידות', 'יחיד', 'יחידת'],
};

// פונקציה לנירמול אותיות סופיות
function normalizeFinalLetters(word) {
    return word.split('').map(char => finalLettersMap[char] || char).join('');
}

// פונקציה גנרית ליצירת ווריאציות עבריות על בסיס דפוסים נפוצים
function generateHebrewVariations(word) {
    const variations = new Set([word]);
    const normalized = normalizeFinalLetters(word.toLowerCase());
    variations.add(normalized);

    // בדיקה אם יש מקרה מיוחד - חיפוש גם במפתחות וגם בערכים
    let foundSpecialCase = false;

    // חיפוש במפתחות
    if (specialCases[normalized]) {
        specialCases[normalized].forEach(variation => {
            variations.add(variation);
            variations.add(normalizeFinalLetters(variation));
        });
        foundSpecialCase = true;
    }

    // חיפוש בערכים של כל הקבוצות
    if (!foundSpecialCase) {
        for (const [key, values] of Object.entries(specialCases)) {
            if (values.includes(normalized) || values.includes(word.toLowerCase())) {
                // מצאנו את המילה בקבוצה - נוסיף את כל הערכים של הקבוצה
                values.forEach(variation => {
                    variations.add(variation);
                    variations.add(normalizeFinalLetters(variation));
                });
                foundSpecialCase = true;
                break; // מצאנו קבוצה, לא צריך לחפש עוד
            }
        }
    }

    // הוספת ווריאציות עם אותיות סופיות - תמיד ליצור גם עם וגם בלי אות סופית
    const addFinalLetterVariations = (baseWord) => {
        // אם המילה נגמרת באות רגילה שיכולה להיות סופית - נוסיף את הצורה הסופית
        if (baseWord.endsWith('מ')) {
            variations.add(baseWord.slice(0, -1) + 'ם');
        }
        if (baseWord.endsWith('נ')) {
            variations.add(baseWord.slice(0, -1) + 'ן');
        }
        if (baseWord.endsWith('פ')) {
            variations.add(baseWord.slice(0, -1) + 'ף');
        }
        if (baseWord.endsWith('צ')) {
            variations.add(baseWord.slice(0, -1) + 'ץ');
        }
        if (baseWord.endsWith('כ')) {
            variations.add(baseWord.slice(0, -1) + 'ך');
        }
        if (baseWord.endsWith('ר')) {
            variations.add(baseWord.slice(0, -1) + 'א');
        }

        // אם המילה נגמרת באות סופית - נוסיף את הצורה הרגילה
        if (baseWord.endsWith('ם')) {
            variations.add(baseWord.slice(0, -1) + 'מ');
        }
        if (baseWord.endsWith('ן')) {
            variations.add(baseWord.slice(0, -1) + 'נ');
        }
        if (baseWord.endsWith('ף')) {
            variations.add(baseWord.slice(0, -1) + 'פ');
        }
        if (baseWord.endsWith('ץ')) {
            variations.add(baseWord.slice(0, -1) + 'צ');
        }
        if (baseWord.endsWith('ך')) {
            variations.add(baseWord.slice(0, -1) + 'כ');
        }
    };

    // החל על המילה המקורית והמנורמלת
    addFinalLetterVariations(word.toLowerCase());
    addFinalLetterVariations(normalized);

    // דפוסים עבריים נפוצים
    const patterns = [
        // ריבוי נקבה → יחיד נקבה
        { from: /ות$/, to: 'ה' },      // "חסות" → "חסה"
        { from: /ות$/, to: 'ית' },     // "יפניות" → "יפנית" 
        { from: /ות$/, to: '' },       // "יפניות" → "יפני"

        // ריבוי זכר → יחיד זכר
        { from: /ים$/, to: '' },       // "חצילים" → "חציל"
        { from: /ים$/, to: 'י' },      // "יפניים" → "יפני"

        // יחיד נקבה → ריבוי נקבה
        { from: /ה$/, to: 'ות' },      // "חסה" → "חסות"
        { from: /ית$/, to: 'ות' },     // "יפנית" → "יפניות"

        // יחיד זכר → ריבוי זכר
        { from: /י$/, to: 'ים' },      // "יפני" → "יפניים"
        { from: /$/, to: 'ים' },       // "חציל" → "חצילים"

        // זכר ↔ נקבה
        { from: /י$/, to: 'ית' },      // "יפני" → "יפנית"
        { from: /ית$/, to: 'י' },      // "יפנית" → "יפני"
        { from: /$/, to: 'ה' },        // "לבן" → "לבנה"  
        { from: /ה$/, to: '' },        // "לבנה" → "לבן"

        // דפוסים נוספים
        { from: /ן$/, to: 'נה' },      // "קטן" → "קטנה"
        { from: /נה$/, to: 'ן' },      // "קטנה" → "קטן"
        { from: /ל$/, to: 'לה' },      // "גדול" → "גדולה"
        { from: /לה$/, to: 'ל' },      // "גדולה" → "גדול"
    ];

    // הפעל כל דפוס על כל הווריאציות שכבר נוצרו
    const currentVariations = Array.from(variations);
    currentVariations.forEach(variation => {
        patterns.forEach(pattern => {
            if (pattern.from.test(variation)) {
                const newWord = variation.replace(pattern.from, pattern.to);
                if (newWord.length > 1) { // וודא שהמילה לא נעלמה
                    variations.add(newWord);
                    variations.add(normalizeFinalLetters(newWord)); // גם עם אותיות סופיות

                    // החל ווריאציות אותיות סופיות על המילה החדשה
                    addFinalLetterVariations(newWord);
                }
            }
        });
    });

    return Array.from(variations).filter(v => v.length > 2);
};

// פונקציה לנירמול מילה עברית כדי להשוות טוב יותר
function normalizeHebrewWord(word) {
    return normalizeFinalLetters(word.toLowerCase().trim());
};

// פונקציה פשוטה להסרת גרשים
function removeApostrophes(text) {
    return text
        .replace(/'/g, '') // הסרת גרש יחיד רגיל
        .replace(/'/g, '') // הסרת גרש מעוקל
        .replace(/`/g, '') // הסרת גרש הפוך
        .replace(/ʼ/g, '') // הסרת גרש יוניקוד
        .replace(/ʻ/g, ''); // הסרת גרש יוניקוד נוסף
};

// פונקציה ליצירת regex שמתעלם מגרשים
function createApostropheIgnoringRegex(word) {
    // הסרת גרשים מהמילה המקורית
    const cleanWord = removeApostrophes(word);

    // יצירת regex שמאפשר גרש אופציונלי בין כל תו
    const regexPattern = cleanWord
        .split('')
        .join('[\'\'`ʼʻ]?'); // גרש אופציונלי בין כל תו

    return new RegExp(regexPattern, 'i');
};

// פונקציה ליצירת ווריאציות לאותיות עבריות שנשמעות דומה
function generateSimilarSoundingVariations(text) {
    if (!text || typeof text !== 'string') return [text];
    
    // מפת אותיות שנשמעות דומה
    const similarLetters = {
        'כ': ['כ', 'ק'],
        'ק': ['כ', 'ק'],
        'ח': ['ח', 'כ'],
        'ת': ['ת', 'ט'],
        'ט': ['ת', 'ט'],
        'ה': ['ה', 'א', 'ע'],
        'א': ['ה', 'א', 'ע'],
        'ע': ['ה', 'א', 'ע'],
        'ו': ['ו', 'ב'],
        'ב': ['ו', 'ב'],
        'ס': ['ס', 'ש'],
        'ש': ['ס', 'ש']
    };

    // פיצול הטקסט למילים
    const words = text.trim().split(/\s+/).filter(Boolean);
    
    // יצירת ווריאציות לכל מילה
    const wordVariations = words.map(word => {
        const variations = new Set([word]);
        
        // עבור כל אות במילה, אם יש לה אותיות דומות - יצור ווריאציות
        for (let i = 0; i < word.length; i++) {
            const currentLetter = word[i];
            if (similarLetters[currentLetter]) {
                const currentVariations = Array.from(variations);
                currentVariations.forEach(variation => {
                    similarLetters[currentLetter].forEach(similarLetter => {
                        if (similarLetter !== currentLetter) {
                            const newVariation = variation.substring(0, i) + 
                                                similarLetter + 
                                                variation.substring(i + 1);
                            variations.add(newVariation);
                        }
                    });
                });
            }
        }

        return Array.from(variations);
    });

    // יצירת כל הקומבינציות של מילים
    const generateCombinations = (wordVariationsArray) => {
        if (wordVariationsArray.length === 0) return [''];
        if (wordVariationsArray.length === 1) return wordVariationsArray[0];
        
        const [firstWordVariations, ...restWordsVariations] = wordVariationsArray;
        const restCombinations = generateCombinations(restWordsVariations);
        
        const combinations = [];
        firstWordVariations.forEach(firstWord => {
            restCombinations.forEach(restCombination => {
                combinations.push(restCombination ? `${firstWord} ${restCombination}` : firstWord);
            });
        });
        
        return combinations.slice(0, 10); // מגביל ל-10 קומבינציות
    };

    return generateCombinations(wordVariations);
};

// מקבל תמלול גולמי ומחזיר { query, quantity }
function parseText(transcript = '') {
    try {
        if (typeof transcript !== 'string' || !transcript.trim()) {
            return { query: '', quantity: 1 };
        }

        /* ─── 1. Normalize ─── */
        const clean = transcript
            .trim()
            .toLowerCase()
            .replace(/[^\u0590-\u05ffa-z0-9\s'\'`ʼʻ]/g, ' ')   // שמירה על גרשים בשלב זה

        /* ─── 2. פיצול למילים ─── */
        const tokens = clean.split(/\s+/).filter(Boolean);

        /* ─── 3. חיפוש כמות ─── */
        let quantity = 1;
        const leftover = [];

        tokens.forEach(tok => {
            /* a) ספרות ישירות –  "2" */
            if (/^\d+$/.test(tok)) {
                quantity = parseInt(tok, 10);
                return;
            }

            /* b) מילים עבריות */
            if (heNumberMap.hasOwnProperty(tok)) {
                quantity = heNumberMap[tok];
                return;
            }

            /* c) מילים אנגליות בסיסיות */
            if (enNumberMap.hasOwnProperty(tok)) {
                quantity = enNumberMap[tok];
                return;
            }

            /* d) מילה "פעמים" - מתעלמים ממנה */
            if (tok === 'פעמים') {
                return;
            }

            /* e) מילים אנגליות מורכבות ("twenty-one") – ננסה words-to-numbers */
            // const maybeNum = wordsToNumbers(tok, { fuzzy: true });
            // if (typeof maybeNum === 'number' && !isNaN(maybeNum)) {
            //     quantity = maybeNum;
            //     return;
            // }

            /* f) לא כמות → נשאר למילת-מוצר */
            leftover.push(tok);
        });

        /* ─── 4. יצירת שאילתת-מוצר ─── */
        let query = leftover.join(' ').trim();
        // console.log('Query before plural handling:', query);
        const cleanName = query;

        // טיפול משופר בריבוי - מילה במילה
        const queryWords = query.split(/\s+/).filter(Boolean);
        const processedWords = queryWords.map(word => {
            // טיפול בריבוי עברית
            if (word.endsWith('ים') && word.length > 3) {
                // console.log(`Removing "ים" from "${word}" → "${word.slice(0, -2)}"`);
                return word.slice(0, -2);  // מסיר "ים"
            }
            if (word.endsWith('ות') && word.length > 3) {
                // console.log(`Removing "ות" from "${word}" → "${word.slice(0, -2)}"`);
                return word.slice(0, -2);  // מסיר "ות"
            }
            // טיפול בריבוי נסמך עברי - "תפוחי" → "תפוח"
            if (word.endsWith('י') && word.length > 3 && !word.endsWith('תי')) {
                // console.log(`Removing "י" from "${word}" → "${word.slice(0, -1)}"`);
                return word.slice(0, -1);  // מסיר "י"
            }
            // טיפול בריבוי נקבה נסמך - "דלעות" → "דלעת", "יפניות" → "יפנית"
            if (word.endsWith('יות') && word.length > 4) {
                // console.log(`Converting "יות" from "${word}" → "${word.slice(0, -3)}ית"`);
                return word.slice(0, -3) + 'ית';  // "יפניות" → "יפנית"
            }
            // טיפול בריבוי אנגלי
            if (word.endsWith('es') && word.length > 3) {
                // console.log(`Removing "es" from "${word}" → "${word.slice(0, -2)}"`);
                return word.slice(0, -2);  // מסיר "es"
            }
            if (word.endsWith('s') && word.length > 3) {
                // console.log(`Removing "s" from "${word}" → "${word.slice(0, -1)}"`);
                return word.slice(0, -1);  // מסיר "s"
            }
            return word;
        });

        query = processedWords.join(' ');
        // console.log('Final query after plural handling:', query);

        // הוספת ווריאציות לאותיות שנשמעות דומה (רק פעם אחת)
        let variations = generateSimilarSoundingVariations(query);
        variations = [cleanName, ...variations];
        // console.log('Similar sounding variations:', variations);

        // הסרת גרשים מהשאילתה הסופית
        query = removeApostrophes(query);

        return { query, quantity, variations };
    }
    catch (err) {
        console.error('parseText error:', err);
        return { query: '', quantity: 1, variations: [] };
    }
};

module.exports = {
    parseText,
    normalizeHebrewWord,
    normalizeFinalLetters,
    generateHebrewVariations,
    generateSimilarSoundingVariations,
    removeApostrophes,
    createApostropheIgnoringRegex
};