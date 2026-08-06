import { callAccurateApi } from "../services/accurateClient";

async function main() {
  const response = await callAccurateApi("GET", "warehouse/list.do", { "sp.pageSize": 100 });

  console.log(response.status);
  console.log(response.data);
}

main();
