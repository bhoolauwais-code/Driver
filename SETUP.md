# Driver — deploying to Netlify

## One-time setup

```bash
cd "C:\Users\User\Desktop\driver-site"
npm install
```

Log in to Netlify, then create the site. The login opens your browser. The
second command makes an empty site and links this folder to it, which the
admin key below needs before it can be set:

```bash
npx netlify login
npx netlify sites:create
```

Then set your admin key, which is what lets you look up a friend's lost code.
Pick something long that only you know:

```bash
npx netlify env:set DRIVER_ADMIN_KEY "some-long-secret-only-you-know"
```

Without it the recovery list refuses to answer at all, rather than quietly
handing out everyone's codes.
Set it before the first deploy. If you change it later, deploy again so the
function picks up the new value.

## Deploy

```bash
npm run deploy
```

That runs the build and pushes it live. **Use this rather than dragging the
folder onto Netlify** — drag-and-drop skips the build, so the function never
gets `@netlify/blobs` installed and every sign-up fails.

## Updating the game

`src/index.html` is what gets published. After changing the game on the
Desktop, copy it in and redeploy:

```bash
copy "C:\Users\User\Desktop\Driver.html" "C:\Users\User\Desktop\driver-site\src\index.html"
npm run deploy
```

## Looking up a lost code

Open this in your browser, with your own key in place of the placeholder:

```
https://YOUR-SITE.netlify.app/api/player?admin=some-long-secret-only-you-know
```

You get every driver, most recently seen first, with their code, their money
and how many cars they have. Keep that URL to yourself — anyone holding it can
sign in as any player.

## The API

| Request | Does |
|---|---|
| `POST /api/player {action:"check", name}` | is a name free |
| `POST /api/player {action:"create", name}` | make a driver, returns their code |
| `POST /api/player {action:"login", name, code}` | fetch a profile |
| `POST /api/player {action:"save", name, code, patch}` | save progress |
| `GET /api/player?list=1` | public roster, for the Racers tab |
| `GET /api/player?admin=KEY` | every name **with its code** |
| `POST /api/player {action:"market", name}` | every car currently up for sale |
| `POST /api/player {action:"sell", name, code, car, price}` | put one of your cars on the board |
| `POST /api/player {action:"unlist", name, code, id}` | take your listing down |
| `POST /api/player {action:"buy", name, code, seller, id}` | buy someone else's listing |

Player records are one blob each, keyed `p/<name>`, so two people signing up at
the same moment can't overwrite one another.

## Parking

The yard draws `parked`, a list of car ids, rather than everything you own.
A profile with no such list parks the lot, so nobody who has never opened the
screen sees a change. The car being driven is always drawn whatever the list
says, because tapping a car in the yard is how you swap and a car you cannot
see is a car you cannot get back to. Putting one away changes nothing but the
view: it is still owned, still sellable, still in the garage list.

## Car rarity

A car is graded on what its engine makes, and nothing about it is set by
hand. Give a car its kilowatts and `CAR_TIERS` decides the band, what it is
worth, how often the box gives it up, and what a duplicate sells on for.

| band | kW | value |
|---|---|---|
| common | 40-60 | R2 500 - R6 000 |
| uncommon | 61-120 | R8 000 - R38 000 |
| rare | 121-160 | R46 000 - R92 000 |
| epic | 161-250 | R115 000 - R285 000 |
| legendary | 251-550 | R350 000 - R1 200 000 |
| mythic | 551+ | R1 600 000 - R4 000 000 |

Where a car sits inside its own band comes from its output, so the strongest
common is worth more than the weakest one.

The box rolls the whole catalogue rather than only the cars you lack. That
matters: a box that skips what you own can never miss, so fifty spins would
buy fifty cars no matter what the weights said, and the bands would be
nothing but the order they arrived in. Landing on a car you already have
pays the band's consolation instead, which is well under the price of a spin
so a run of duplicates still costs you. The starter never comes up.

## Paint

A respray is worked out from the artwork rather than stored as a second set
of sprites. The panels are the pixels sharing the colour the car left the
factory in, found once per car; each is then put back through a ramp built
from the chosen colour, so the shading and the shut lines survive and the
glass, tyres, black trim and clear lenses are left alone. On the two red
cars the tail light lens is the same red as the paint, so it takes the new
colour with the rest of the shell.

The choice is one hex colour per car, kept in `paint` on the profile and
checked against `#rrggbb` before it is stored.

## The leaderboards

Both boards are built from `?list=1`, the same public roster the Racers tab
uses, so they cover everybody who has ever signed up rather than a separate
table. Furthest reads `bestDistance`; quickest reads `bestEt`, the quarter mile
kept in hundredths of a second so it stays an integer through the range checks.
`bestDistance` is saved as the larger of the two values and `bestEt` as the
smaller, so an old, slower time can never overwrite a good one.

Money, best score and cars owned are only accepted through `save`, which
requires the code, and each field is range-checked. Nothing stops a determined
player editing their own numbers within those ranges — proper protection means
scoring races server-side, which is worth doing once wagering exists.

## The marketplace

A listing lives on the seller's own record, so two people listing at the same
moment write different blobs and neither is lost. The board is gathered by
reading them all back.

A sale writes the seller first — the listing goes and the car leaves their
garage — and only then charges the buyer, so the same car cannot be sold twice
if two people tap at once. You cannot list your only car, and a purchase that
would leave the seller with nothing is refused rather than allowed.

Because money and cars are still accepted from the client through `save`, a
seller whose game is open elsewhere could push a stale garage back over a sale.
The game re-reads the profile whenever the marketplace opens, which is when a
seller would notice, but scoring the whole thing server-side is the real fix
and is worth doing at the same time as wagering.

## Testing locally

```bash
node "C:\Users\User\Desktop\driver-server.js"
```

That serves the game at http://localhost:8123 and mirrors the same
`/api/player` endpoint, storing players in `driver-players.json` next to it.
The local admin key defaults to `letmein`.
