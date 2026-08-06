import { getAccurateHost } from "../services/accurateClient";

async function main() {
  const response = await getAccurateHost();
  console.log(response.status);
  console.log(response.data);
}

main();
