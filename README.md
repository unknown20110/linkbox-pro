# LinkBox Pro

לוח קישורים פרטי מהרשתות: תצוגה מקדימה כמו בוואטסאפ (תמונה, כותרת, תיאור), חלוקה לנושאים, מועדפים, חיפוש, ומצב כהה. סנכרון בין מכשירים דרך חשבון Google.

## מבנה הפרויקט

```
index.html                      ← ה-frontend (עברית RTL, Tailwind CDN, Heebo)
netlify/functions/preview.js    ← שרת שמחלץ מטא-דאטה (רץ על Netlify)
package.json                    ← תלות אחת: cheerio
netlify.toml                    ← הגדרות Netlify
```

## איך חילוץ המטא-דאטה עובד

הדפדפן קורא ל-`/.netlify/functions/preview?url=...` והפונקציה מנסה לפי הסדר:

1. **YouTube** ← oEmbed
2. **TikTok** ← oEmbed
3. **כל אתר אחר** (וגם אם ב-1 או 2 חסר משהו) ← מורידה את הדף ומקריאה `og:title`, `og:description`, `og:image`. עבור אינסטגרם ופייסבוק היא מזדהה בתור ה-crawler של פייסבוק, כי הוא מקבל תגיות OG יותר בקלות מדפדפן רגיל.
4. **גיבוי** ← microlink.io (המנוי החינמי מוגבל בכמות בקשות ליום)
5. **מוצא אחרון** ← שם הדומיין כשם הקישור, כדי שתמיד אפשר יהיה לשמור, ולערוך את הכותרת ידנית לפני השמירה.

הפונקציה מחזירה JSON נקי: `{ title, description, image, site, type, source }`. השדה `source` אומר מאיפה הגיע המידע (`oembed` / `web` / `microlink` / `fallback`) וכדאי לבדוק אותו בכלי המפתחים אם קישור מסוים לא נראה טוב.

**אבטחה:** אימות כתובת (http/https בלבד), חסימת כתובות פנימיות ו-localhost (הגנת SSRF, כולל בכל הפניה), מגבלת 2MB על ה-HTML, timeout של 8 שניות, ורק JSON חוזר החוצה.

> ⚠️ **אינסטגרם:** אין דרך רשמית וחופשית לקבל מטא-דאטה מאינסטגרם. לפעמים היא תחזיר תמונה וכותרת ולפעמים תציג לשרת דף התחברות. במקרה כזה תקבל כרטיס עם שם הדומיין ותוכל לכתוב כותרת בעצמך. בנוסף, תמונות מה-CDN של אינסטגרם פוקעות אחרי כמה ימים, ואז יוצג במקומן מקום שמור בצבע הפלטפורמה. הקישור עצמו תמיד יישמר ויעבוד.

## הגדרת Firebase (5 דקות)

1. היכנס ל-[console.firebase.google.com](https://console.firebase.google.com) ← **Add project**.
2. **Authentication** ← Get started ← Sign-in method ← הפעל **Google**.
3. **Firestore Database** ← Create database (Production mode).
4. בלשונית **Rules** הדבק ופרסם:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /links/{id} {
      allow read, update, delete: if request.auth != null && resource.data.uid == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
    }
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

5. **Project settings** ← Your apps ← הוסף אפליקציית **Web** (`</>`) והעתק את אובייקט `firebaseConfig`.
6. פתח את `index.html`, חפש `const firebaseConfig` והדבק שם את הערכים שלך במקום ה-`YOUR_...`.
7. אחרי ההעלאה ל-Netlify: **Authentication ← Settings ← Authorized domains** ← הוסף את הדומיין של האתר (למשל `my-linkbox.netlify.app`). בלי זה ההתחברות תיכשל עם השגיאה `unauthorized-domain`.

### אינדקס ב-Firestore

השאילתה מסננת לפי `uid` וממיינת לפי `createdAt`, ולכן Firestore דורש אינדקס מורכב. באפליקציה הכל ימשיך לעבוד גם בלעדיו (המיון יתבצע בדפדפן), אבל כדאי ליצור אותו: פתח את הקונסול בדפדפן אחרי ההתחברות הראשונה, ובהודעה `Missing Firestore index` יש קישור אחד שיוצר את האינדקס בלחיצה.

## העלאה ל-Netlify

1. העלה את **כל התיקייה** ל-GitHub (`git init`, `git add .`, `git commit`, `git push`).
2. ב-Netlify: **Add new site ← Import an existing project** ← בחר את הריפו. אין צורך בפקודת build. ההגדרות כבר ב-`netlify.toml`.
3. ⚠️ גרירת `index.html` בלבד לא תעבוד, כי בלי התיקייה `netlify/functions` אין תצוגה מקדימה.

## הרצה מקומית

```bash
npm install
npx netlify-cli dev
```

שרת סטטי רגיל (למשל Live Server) יציג את האפליקציה, אבל בלי הפונקציה. כל קישור יישמר עם שם הדומיין בלבד, ותוכל לערוך את הכותרת ידנית.

## מצב מקומי (בלי Firebase)

כל עוד `firebaseConfig` מכיל `YOUR_...`, האפליקציה לא מבקשת התחברות ושומרת הכל ב-LocalStorage של הדפדפן (מוצג תג "מצב מקומי" בכותרת). אין סנכרון בין מכשירים, ולכן מחיקת נתוני הדפדפן תמחק את הקישורים.

## מבנה הנתונים

אוסף `links`: `uid, url, title, description, image, topic, createdAt, fav`.
המסמך `users/{uid}` שומר את הנושאים שיצרת בעצמך (`topics`), כדי שיסונכרנו בין מכשירים.

## טיפים

- **התחברות עם Google מתוך דפדפן פנימי** של אינסטגרם או וואטסאפ נחסמת על ידי Google. פתח את האתר בכרום או בספארי.
- כשמשתפים קישור מאינסטגרם, לפעמים מודבק טקסט יחד עם הקישור. האפליקציה מחלצת לבד את הכתובת מתוך הטקסט.
