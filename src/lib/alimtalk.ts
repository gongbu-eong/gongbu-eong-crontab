import { env } from "../config";
import { executeQuery } from "./mssqldb";

export type AlimtalkSendInput = {
  recipientPhone: string | null | undefined;
  templateCode: string | null | undefined;
  message: string;
  title: string;
  targetPath?: string | null;
  buttonName?: string;
};

export async function sendAlimtalk(input: AlimtalkSendInput) {
  const phone = normalizePhone(input.recipientPhone);
  const templateCode = input.templateCode?.trim();

  if (!env.alimtalkSenderKey || !templateCode || !phone) {
    return { sent: false, reason: "missing_config_or_recipient" as const };
  }

  const targetUrl = input.targetPath ? new URL(input.targetPath, env.mainUrl).toString() : "";
  const attachment = targetUrl
    ? JSON.stringify({
        button: [
          {
            name: input.buttonName || "확인",
            type: "WL",
            url_mobile: targetUrl,
            url_pc: targetUrl,
          },
        ],
      })
    : "";

  await executeQuery(`
    INSERT INTO dbo.MZSENDTRAN (
      SN,
      SENDER_KEY,
      CHANNEL,
      SND_TYPE,
      PHONE_NUM,
      TMPL_CD,
      SND_MSG,
      REQ_DTM,
      SMS_SND_YN,
      SMS_SND_MSG,
      SLOT1,
      SMS_SND_NUM,
      ATTACHMENT
    ) VALUES (
      (next value for mzsendtran_seq),
      '${escapeMssql(env.alimtalkSenderKey)}',
      'A',
      'P',
      '${escapeMssql(phone)}',
      '${escapeMssql(templateCode)}',
      N'${escapeMssql(input.message)}',
      convert(varchar(8), getdate(), 112) + replace(convert(varchar(8), getdate(), 108), ':', ''),
      'N',
      N'${escapeMssql(input.message)}',
      N'${escapeMssql(input.title)}',
      '${escapeMssql(env.alimtalkSmsSenderNumber)}',
      ${attachment ? `N'${escapeMssql(attachment)}'` : "NULL"}
    );
  `);

  return { sent: true };
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function escapeMssql(value: string) {
  return value.replace(/'/g, "''");
}
