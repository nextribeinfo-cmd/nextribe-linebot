const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const STAFF = [
  { name: '村田雄哉',   start: 1, end: null },
  { name: '山崎龍之介', start: 1, end: null },
  { name: '光冨大輔',   start: 1, end: null },
  { name: '鮎川公彦',   start: 1, end: null },
  { name: '永島大夢',   start: 1, end: null },
  { name: '上原恵介',   start: 1, end: null },
];

// スターク案件請求設定
const STARK_RATES = {
  '村田雄哉': 30000,
  '鮎川公彦': 25000,
  '永島大夢': 22000,
  '上原恵介': 20000,
};

// 村田の店舗別交通費（往復km, 有料道路料金円/往復）
const MURATA_ROUTES = {
  'イオンモール佐賀大和': { km: 86, toll: 640, tollName: '三瀬有料道路320円×2' },
  'ドコモショップ佐賀夢咲': { km: 96, toll: 640, tollName: '三瀬有料道路320円×2' },
};

// 重複処理防止（同じメッセージIDを2回処理しない）
const processedIds = new Set();

app.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const msgId = event.message.id;
      if (processedIds.has(msgId)) continue;
      processedIds.add(msgId);
      if (processedIds.size > 1000) {
        const arr = [...processedIds];
        arr.slice(0, 500).forEach(id => processedIds.delete(id));
      }
      try {
        const result = await parseAndAddSchedule(event.message.text);
        await replyMessage(event.replyToken, result);
      } catch (err) {
        console.error('webhook error:', err.message);
      }
    }
  }
});

// 月末請求書データ生成エンドポイント
app.get('/generate-invoice', async (req, res) => {
  // CORS許可（Netlifyからのアクセス用）
  res.header('Access-Control-Allow-Origin', '*');

  const month = parseInt(req.query.month);
  if (!month || month < 1 || month > 12) {
    return res.status(400).json({ error: '月を指定してください (1-12)' });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}月!A1:AF20`,
    });
    const rows = result.data.values || [];

    const year = new Date().getFullYear();
    const mm = String(month).padStart(2, '0');
    const items = [];
    const transportParagraphs = [];
    const unknownLocations = [];

    rows.forEach(row => {
      const staffName = row[0]?.trim();
      const rate = STARK_RATES[staffName];
      if (!rate) return;

      const surname = staffName.slice(0, 2);
      let workDays = 0;
      let lastDay = 0;
      const locationCounts = {}; // 村田用：場所ごとの日数集計

      for (let col = 2; col < row.length; col++) {
        const location = row[col]?.trim();
        if (!location) continue;
        const day = col - 2;
        workDays++;
        if (day > lastDay) lastDay = day;

        if (staffName === '村田雄哉') {
          locationCounts[location] = (locationCounts[location] || 0) + 1;
        }
      }

      if (workDays === 0) return;

      const dd = String(lastDay).padStart(2, '0');
      items.push({
        name: `[${year}/${mm}/${dd} 納品分] ${surname}イベント稼動費`,
        qty: workDays,
        price: rate,
      });

      if (staffName === '村田雄哉') {
        let transportTotal = 0;
        const detailParts = [];
        for (const [location, days] of Object.entries(locationCounts)) {
          const route = MURATA_ROUTES[location];
          if (route) {
            const gas = route.km * 15;
            const dayCost = gas + route.toll;
            transportTotal += dayCost * days;
            detailParts.push(`${location}:${route.tollName},ガソリン代${route.km}km×15円=${gas.toLocaleString()}円計${dayCost.toLocaleString()}円×${days}日=${(dayCost * days).toLocaleString()}円`);
          } else if (!unknownLocations.includes(location)) {
            unknownLocations.push(location);
          }
        }
        if (transportTotal > 0) {
          // 実費は税込相当のため税抜換算で計上（消費税10%加算後に実費と一致）
          items.push({
            name: `[${year}/${mm}/${dd} 納品分] 上記交通費`,
            qty: 1,
            price: Math.round(transportTotal / 1.1),
          });
          transportParagraphs.push(`村田交通費詳細(${detailParts.join(',')})`);
        }
      } else {
        // 他スタッフの交通費は先方請求書ベースで手動入力（税抜額を入れる）
        items.push({
          name: `[${year}/${mm}/${dd} 納品分] 上記交通費`,
          qty: 1,
          price: 0,
        });
      }
    });

    const transportDetail = transportParagraphs.join('\n') +
      (unknownLocations.length > 0 ? '\n\n※村田の交通費未計算の勤務先（要確認）：' + unknownLocations.join('、') : '');

    res.json({
      month,
      items,
      transportDetail,
      unknownLocations,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.options('/generate-invoice', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.sendStatus(200);
});

async function parseAndAddSchedule(message) {
  const foundStaff = STAFF.find(s => message.includes(s.name));
  if (!foundStaff) return '❌ スタッフ名が見つかりませんでした。\n\n例:\n村田雄哉の6月は6.7イオンモール佐賀大和、8.9.10ブランチ博多\n\n複数行でも可:\n村田雄哉の6月は\n6.7イオンモール佐賀大和\n8.9.10ブランチ博多';

  const monthMatch = message.match(/(\d+)月/);
  if (!monthMatch) return '❌ 月が見つかりませんでした。';
  const month = parseInt(monthMatch[1]);

  const afterMonth = message.replace(/^.*?\d+月\D*/, '').trim();
  if (!afterMonth) return '❌ スケジュール内容が見つかりません。';

  let addedDetails = [];

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}月!A1:A20`,
    });
    const rows = res.data.values || [];
    let staffRow = -1;
    rows.forEach((row, i) => {
      if (row[0] === foundStaff.name) staffRow = i + 1;
    });
    if (staffRow === -1) return `❌ ${foundStaff.name}の行が見つかりません。`;

    const entryRegex = /(\d+(?:\.\d+)*)([^\d,、，\n\r]+)/g;
    const updates = [];
    let match;
    while ((match = entryRegex.exec(afterMonth)) !== null) {
      const days = match[1].replace(/\.$/, '').split('.').map(Number).filter(d => d >= 1 && d <= 31);
      const location = match[2].trim();
      if (days.length === 0 || !location) continue;
      days.forEach(day => {
        const col = colIndex(day + 2);
        updates.push({ range: `${month}月!${col}${staffRow}`, values: [[location]] });
        addedDetails.push(`${day}日 → ${location}`);
      });
    }

    if (updates.length === 0) return '❌ スケジュールを読み取れませんでした。\n\n例:\n村田雄哉の6月は6.7イオンモール佐賀大和、8.9.10ブランチ博多';

    for (const u of updates) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: u.range,
        valueInputOption: 'RAW',
        requestBody: { values: u.values },
      });
    }
  } catch (err) {
    console.error(err);
    return '❌ スプレッドシートへの書き込みに失敗しました。';
  }

  return `✅ ${foundStaff.name}の${month}月スケジュールを追加！\n\n` + addedDetails.join('\n');
}

function colIndex(n) {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }],
  }, {
    headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
  });
}

app.get('/', (req, res) => res.send('NEXTRIBE LINE Bot running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
