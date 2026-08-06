import { getEnv, updateEnv } from "../env";
import { exchangeTikTokToken } from "../services/tiktokAuth";

async function main() {
  const authCode = getEnv("AUTH_CODE");
  try {
    const { accessToken, refreshToken } = await exchangeTikTokToken(authCode);
    updateEnv("ACCESS_TOKEN", accessToken);
    updateEnv("REFRESH_TOKEN", refreshToken);
    console.log("Exchanged. ACCESS_TOKEN/REFRESH_TOKEN saved to .env.");
  } catch (err: any) {
    console.log("Request failed, not saving to .env:", err?.message ?? err);
  }
}

main();
