/* $CATBOY merch catalog — display + pricing. No secrets here.
   Prices are in whole $CATBOY tokens. The real treasury address and the
   Printful catalog variant ids live server-side (api/merch.js env), so this
   file is safe to serve publicly. Edit products/prices freely. */
window.CATBOY_MERCH = {
  token: "$CATBOY",
  mint: "3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump",
  categories: ["Tees", "Hoodies", "Hats", "Mugs", "Posters", "Accessories"],
  // holders/NFT owners get a discount applied server-side; shown here for the badge
  holderDiscountPct: 15,
  products: [
    { id: "tee-classic",   name: "Classic Catboy Tee",        cat: "Tees",        design: "assets/merch/classic.png",   priceCatboy: 5000000,  options: ["S", "M", "L", "XL", "2XL"], blurb: "The mascot — clean and loud." },
    { id: "tee-dragon",    name: "Dragon Rider Tee",          cat: "Tees",        design: "assets/merch/dragon.png",    priceCatboy: 6000000,  options: ["S", "M", "L", "XL", "2XL"], blurb: "Back-print — Catboy torching the field." },
    { id: "tee-nine",      name: "Nine Lives Tee",            cat: "Tees",        design: "assets/merch/ninelives.png", priceCatboy: 5000000,  options: ["S", "M", "L", "XL", "2XL"], blurb: "Nine lives, one legend." },
    { id: "hoodie-dragon", name: "Dragon Rider Hoodie",       cat: "Hoodies",     design: "assets/merch/dragon.png",    priceCatboy: 12000000, options: ["S", "M", "L", "XL", "2XL"], blurb: "Heavyweight back-print hoodie." },
    { id: "hoodie-nine",   name: "Nine Lives Hoodie",         cat: "Hoodies",     design: "assets/merch/ninelives.png", priceCatboy: 12000000, options: ["S", "M", "L", "XL", "2XL"], blurb: "Cozy and legendary." },
    { id: "mug-classic",   name: "Catboy Mug",                cat: "Mugs",        design: "assets/merch/classic.png",   priceCatboy: 3000000,  options: ["11oz", "15oz"],             blurb: "Morning fuel, degen-approved." },
    { id: "poster-nine",   name: "Nine Lives Poster",         cat: "Posters",     design: "assets/merch/ninelives.png", priceCatboy: 4000000,  options: ["12×18", "18×24"],           blurb: "Matte wall art." },
    { id: "poster-dragon", name: "Dragon Poster",             cat: "Posters",     design: "assets/merch/dragon.png",    priceCatboy: 4000000,  options: ["12×18", "18×24"],           blurb: "The dragon ride, framed." },
  ],
};
