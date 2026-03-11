import { google } from "googleapis";

export type ReceiptRow = {
  date: string;
  vendor: string;
  amount: string | number;
  category: string;
  notes?: string;
  source?: string;
};

const getSheetsConfig = () => {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim() || "";
  const privateKeyRaw = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.trim() || "";
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() || "";
  const sheetTab = process.env.GOOGLE_SHEETS_TAB?.trim() || "Sheet1";

  if (!clientEmail || !privateKeyRaw || !spreadsheetId) {
    throw new Error(
      "Missing Google Sheets config. Set GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY, and GOOGLE_SHEETS_SPREADSHEET_ID.",
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  return { clientEmail, privateKey, spreadsheetId, sheetTab };
};

const getSheetsClient = () => {
  const { clientEmail, privateKey } = getSheetsConfig();
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
};

export const appendReceiptRow = async (row: ReceiptRow) => {
  const { spreadsheetId, sheetTab } = getSheetsConfig();
  const sheets = getSheetsClient();

  const values = [
    [
      row.date,
      row.vendor,
      String(row.amount),
      row.category,
      row.notes ?? "",
      row.source ?? "",
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetTab}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
};
