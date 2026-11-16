# עוזר שטח לטכנאים על מאגרי ידע מתחלפים

הטכנאי שואל בכתב, בתמונה, בסרטון או בשיחה. העוזר עונה מהמסמכים שבמאגר, עם המקור. כשהמסמכים לא מכסים את התקלה הוא מציע מקומות לבדיקה מידע מקצועי כללי, מסומנים "לא מהמדריך".

- אפיון: [`docs/spec-v2.md`](docs/spec-v2.md) (פלטפורמת המאגרים) ו-[`docs/spec.md`](docs/spec.md) (עצי התקלות המקוריים).
- כללי עבודה ל-Claude Code: [`CLAUDE.md`](CLAUDE.md).

## הרצה מקומית
```bash
npm install
```
```bash
ANTHROPIC_API_KEY=... ADMIN_PASSWORD=... npm run dev
```
- מסך הטכנאי: `http://localhost:3000`
- מסך המטמיע: `http://localhost:3000/admin`

## משתני סביבה
| משתנה | חובה | מה הוא עושה |
|---|---|---|
| `ANTHROPIC_API_KEY` | כן | מפתח ה-API של המודל. בלעדיו אין תשובות. |
| `ADMIN_PASSWORD` | כן בייצור | הסיסמה של `/admin`. בלעדיה האזור סגור בייצור ופתוח בפיתוח. |
| `ACCESS_CODE` | מומלץ | קוד כניסה לטכנאים. בלעדיו אזור הטכנאי פתוח לכל מי שיש לו את הקישור. |
| `SESSION_SECRET` | מומלץ | מפתח אקראי לחתימת ה-sessions. בלעדיו המפתח נגזר מהסיסמה ומהקוד. |
| `DAILY_QUESTION_LIMIT` | לא | תקרת שאלות ביום לכל השירות. ברירת מחדל: 1000. |
| `DATA_DIR` | לא | איפה נשמרים המאגרים. ברירת מחדל: `./data`. בייצור: תיקייה קבועה (volume). |
| `HIDE_SAMPLE_KB` | לא | `1` מסתיר את מאגר עצי התקלות לדוגמה. |
| `EMBEDDINGS` | לא | `vertex` מפעיל חיפוש לפי משמעות (היברידי) דרך Vertex AI. בלעדיו: חיפוש לפי מילים. |
| `EMBED_MODEL` | לא | מודל ה-embedding. ברירת מחדל: `text-multilingual-embedding-002`. שינוי מחייב בנייה מחדש של האינדקס. |
| `EMBED_LOCATION` | לא | האזור של Vertex AI. ברירת מחדל: `us-central1`. |
| `VOICE` | לא | `google` מפעיל קול טבעי בשיחה דרך Google Cloud Text-to-Speech. |
| `TTS_VOICE` | לא | קול ברירת המחדל, עד שנבחר קול ב-`/admin`. |
| `FIRST_SEARCH` | לא | איך רץ החיפוש הראשון: `parallel` (ברירת מחדל), `sequential`, `meaning`. |
| `EMBED_BATCH` | לא | כמה קטעים בבקשה אחת. ברירת מחדל: 16. למודל שמקבל קטע אחד בבקשה: `1`. |

### קול טבעי בשיחה (Google Cloud Text-to-Speech)
גם כאן אין מפתח: השירות מזדהה בזהות שלו. פעם אחת, ב-Cloud Shell:
```bash
gcloud services enable texttospeech.googleapis.com
```
```bash
gcloud run services update field-assistant --region me-west1 --update-env-vars VOICE=google
```
אחר כך, ב-`/admin`, תחת "מצב המערכת": "הצגת הקולות", האזנה לכל קול, ו"בחירה". בלי `VOICE` מדבר הקול המובנה של הטלפון.
`TTS_VOICE` קובע קול ברירת מחדל לפני שנבחר אחד במסך.

אפשר להוסיף עוד ספקי קול כדי להשוות ביניהם באותה רשימה. כל ספק דורש חשבון ומפתח משלו. את המפתח שמים
במשתני הסביבה של Cloud Run (עדיף ב-Secret Manager), אף פעם לא בקוד:
- Microsoft Azure Speech: `AZURE_SPEECH_KEY` ו-`AZURE_SPEECH_REGION` (למשל `westeurope`). `AZURE_VOICE` לקול ברירת מחדל.
- ElevenLabs: `ELEVENLABS_API_KEY`. `ELEVENLABS_MODEL` (ברירת מחדל `eleven_v3`) ו-`ELEVENLABS_VOICE` לקול ברירת מחדל.

### חיפוש לפי משמעות (Vertex AI)
ב-Cloud Run אין צורך במפתח: השירות מזדהה בזהות שלו. פעם אחת, ב-Cloud Shell:
```bash
gcloud services enable aiplatform.googleapis.com
```
```bash
gcloud run services update field-assistant --region me-west1 --update-env-vars EMBEDDINGS=vertex
```
אחר כך, ב-`/admin`: "בדיקת חיבור למודל" מציגה שורה "חיפוש לפי משמעות", ולכל מסמך קיים יש כפתור "השלמת האינדקס".
מסמך חדש נכנס לאינדקס מיד אחרי ההעלאה. אם הבדיקה מחזירה 403, חשבון השירות צריך את התפקיד "Vertex AI User".

## פריסה
האפליקציה צריכה שרת Node רגיל עם דיסק קבוע, כי המסמכים נשמרים בתיקייה.
ה-`Dockerfile` מתאים לכל שירות שמריץ קונטיינר עם volume (Railway, Render, Fly.io):
1. מחברים את הריפו לשירות.
2. מוסיפים volume ומחברים אותו ל-`/data`.
3. מגדירים `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD` ו-`ACCESS_CODE`.
4. נכנסים ל-`/admin`, ומעלים את המסמכים.

### Google Cloud Run (סקריפט אחד)
ב-[Google Cloud Shell](https://shell.cloud.google.com), מתוך תיקיית הריפו:
```bash
./scripts/deploy-gcp.sh
```
הסקריפט מבקש את המפתח, את הסיסמה ואת קוד הכניסה, יוצר bucket למסמכים, מחבר אותו כ-`/data`, ופורס את השירות.
אפשר להריץ אותו שוב כדי לעדכן גרסה. המסמכים נשארים ב-bucket.

Vercel לא מתאים כמו שהוא: אין בו דיסק קבוע, והעלאות מוגבלות ל-4.5MB.
מצלמה ומיקרופון בטלפון עובדים רק ב-HTTPS, ושירותי האחסון האלה נותנים HTTPS אוטומטית.

לפני דמו: [`docs/demo-checklist.md`](docs/demo-checklist.md). ממצאי הביקורת והפתוחים: [`docs/audit-2026-11.md`](docs/audit-2026-11.md).

## בדיקות
```bash
npm test
```
```bash
npm run kb:validate
```
הבדיקות לא פונות לרשת. המודל בהן מדומה.
