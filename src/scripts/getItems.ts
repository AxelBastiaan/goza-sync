import { callAccurateApi } from "../services/accurateClient";

async function main() {
  const response = await callAccurateApi("GET", "item/list.do", {
    fields: "id,name,no,quantity",
  });

  console.log(response.status);
  console.log(response.data);
}

main();
