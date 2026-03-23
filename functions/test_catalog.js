// Test items_batch - último intento después de esperar
const fetch = require("node-fetch");

const CATALOG_ID = "2123445418508910";
const TOKEN = "EAAXL9K4smqkBRALIfa6sZAqXbBMDc60GaSUBdCrbPq12ISSn3XonxdEbihRKjhZAVxEejIph6cLyY0Rijj5ZBrZCjyFNVI5TMvez1nCG0Yk2xFDR1MRyIzYboa1iau5X74ET4IiHgK32MiQ9Haso5eYrXDrwaECxdYPlqclEsZC4GzQt4WFfc5DzVbrokOXdySAZDZD";

async function test() {
  const url = "https://graph.facebook.com/v22.0/" + CATALOG_ID + "/items_batch";

  const requests = [{
    method: "CREATE",
    data: {
      id: "test_prod_001",
      title: "Producto de Prueba",
      description: "Descripcion de prueba para sync del catalogo",
      availability: "in stock",
      condition: "new",
      price: "500000 CRC",
      link: "https://aqui-pauli.web.app",
      brand: "Aqui Pauli",
      image: [{ url: "https://static.nike.com/a/images/t_PDP_936_v8/f_auto,q_auto,u_126ab356-44d8-4a06-89b4-fcdcc8df0245,c_scale,fl_relative,w_1.0,h_1.0,fl_layer_apply/example.jpg" }],
    },
  }];

  console.log("Enviando request...");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: TOKEN,
      item_type: "PRODUCT_ITEM",
      requests: JSON.stringify(requests),
    }),
  });

  const data = await resp.json();
  console.log("Status:", resp.status);
  console.log("Response:", JSON.stringify(data, null, 2));
  
  for (const [key, value] of resp.headers.entries()) {
    if (key.includes("usage") || key.includes("limit") || key.includes("retry")) {
      console.log(key + ":", value);
    }
  }
}

test().catch(err => console.error("Error:", err));
