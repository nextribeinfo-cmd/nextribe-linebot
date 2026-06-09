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
];

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
      // メモリ節約のため古いIDを削除（1000件超えたら半分削除）
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

async function parseAndAddSchedule(message) {
  const foundStaff = STAFF.find(s => message.includes(s.name));
  if (!foundStaff) return '❌ スタッフ名が見つかりませんでした。\n\n例:\n村田雄哉の6月は6.7イオンモール佐賀大和、8.9.10ブランチ博多\n\n複数行でも可:\n村田雄哉の6月は\n6.7イオンモール佐賀大和\n8.9.10ブランチ博多';

  const monthMatch = message.match(/(\d+)月/);
  if (!monthMatch) return '❌ 月が見つかりませんでした。';
  const month = parseInt(monthMatch[1]);

  const afterMonth = message.replace(/^.*?\d+月は?/, '').trim();
  if (!afterMonth) return '❌ スケジュール内容が見つかりません。';

  // 「、,，」と改行の両方で分割
  const segments = afterMonth.split(/[、,，\n\r]+/);
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

    const updates = [];
    segments.forEach(seg => {
      seg = seg.trim();
      if (!seg) return;
      // 先頭の数字（ドット区切り可）+ 残りを場所とみなす
      const match = seg.match(/^([\d.]+)\s*(.+)$/);
      if (!match) return;
      const days = match[1].replace(/\.$/, '').split('.').map(Number).filter(d => d >= 1 && d <= 31);
      const location = match[2].trim();
      days.forEach(day => {
        const col = colIndex(day + 2);
        updates.push({ range: `${month}月!${col}${staffRow}`, values: [[location]] });
        addedDetails.push(`${day}日 → ${location}`);
      });
    });

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
