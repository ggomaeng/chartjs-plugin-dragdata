#!/usr/bin/env node

const handleError = require("./utils/handleError");
process.on("unhandledRejection", handleError);
process.on("uncaughtException", handleError);

const path = require("path");
require("dotenv").config();
const { ENV_KEYS } = require("./projects/helper/env");
const {
  util: {
    blocks: { getCurrentBlocks },
    humanizeNumber: { humanizeNumber },
  },
} = require("@defillama/sdk");
const { util } = require("@defillama/sdk");
const sdk = require("@defillama/sdk");
const whitelistedExportKeys = require("./projects/helper/whitelistedExportKeys.json");
const chainList = require("./projects/helper/chains.json");
const {
  log,
  diplayUnknownTable,
  sliceIntoChunks,
} = require("./projects/helper/utils");
const { normalizeAddress } = require("./projects/helper/tokenMapping");
const { PromisePool } = require("@supercharge/promise-pool");
const { Webhook, MessageBuilder } = require("discord-webhook-node");
const hook = new Webhook(process.env.DISCORD_MINT_CLUB_TVL_WEBHOOK);

const currentCacheVersion = sdk.cache.currentVersion; // load env for cache
// console.log(`Using cache version ${currentCacheVersion}`)

if (process.env.LLAMA_SANITIZE)
  Object.keys(process.env).forEach((key) => {
    if (key.endsWith("_RPC")) return;
    if (
      ["TVL_LOCAL_CACHE_ROOT_FOLDER", "LLAMA_DEBUG_MODE", ...ENV_KEYS].includes(
        key
      ) ||
      key.includes("SDK")
    )
      return;
    delete process.env[key];
  });

async function getTvl(
  unixTimestamp,
  ethBlock,
  chainBlocks,
  usdTvls,
  tokensBalances,
  usdTokenBalances,
  tvlFunction,
  isFetchFunction,
  storedKey
) {
  const chain = storedKey.split("-")[0];
  const api = new sdk.ChainApi({
    chain,
    block: chainBlocks[chain],
    timestamp: unixTimestamp,
    storedKey,
  });
  api.api = api;
  api.storedKey = storedKey;
  if (!isFetchFunction) {
    let tvlBalances = await tvlFunction(api, ethBlock, chainBlocks, api);
    if (!tvlBalances && Object.keys(api.getBalances()).length)
      tvlBalances = api.getBalances();
    const tvlResults = await computeTVL(tvlBalances, "now");
    await diplayUnknownTable({ tvlResults, storedKey, tvlBalances });
    usdTvls[storedKey] = tvlResults.usdTvl;
    tokensBalances[storedKey] = tvlResults.tokenBalances;
    usdTokenBalances[storedKey] = tvlResults.usdTokenBalances;
  } else {
    usdTvls[storedKey] = Number(
      await tvlFunction(api, ethBlock, chainBlocks, api)
    );
  }
  if (
    typeof usdTvls[storedKey] !== "number" ||
    Number.isNaN(usdTvls[storedKey])
  ) {
    throw new Error(
      `TVL for key ${storedKey} is not a number, instead it is ${usdTvls[storedKey]}`
    );
  }
}

function mergeBalances(key, storedKeys, balancesObject) {
  if (balancesObject[key] === undefined) {
    balancesObject[key] = {};
    storedKeys.map((keyToMerge) => {
      Object.entries(balancesObject[keyToMerge]).forEach((balance) => {
        try {
          util.sumSingleBalance(
            balancesObject[key],
            balance[0],
            BigNumber(balance[1] || "0").toFixed(0)
          );
        } catch (e) {
          console.log(e);
        }
      });
    });
  }
}

const originalCall = sdk.api.abi.call;
sdk.api.abi.call = async (...args) => {
  try {
    return await originalCall(...args);
  } catch (e) {
    console.log("sdk.api.abi.call errored with params:", args);
    throw e;
  }
};

(async () => {
  const module = require("./projects/mint-club-v2/index.js");
  const unixTimestamp = Math.round(Date.now() / 1000) - 60;
  const { chainBlocks } = await getCurrentBlocks([]); // fetch only ethereum block for local test
  const ethBlock = chainBlocks.ethereum;
  const usdTvls = {};
  const tokensBalances = {};
  const usdTokenBalances = {};
  const chainTvlsToAdd = {};
  const knownTokenPrices = {};

  let tvlPromises = Object.entries(module).map(async ([chain, value]) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    return Promise.all(
      Object.entries(value).map(async ([tvlType, tvlFunction]) => {
        if (typeof tvlFunction !== "function") {
          return;
        }
        let storedKey = `${chain}-${tvlType}`;
        let tvlFunctionIsFetch = false;
        if (tvlType === "tvl") {
          storedKey = chain;
        } else if (tvlType === "fetch") {
          storedKey = chain;
          tvlFunctionIsFetch = true;
        }
        await getTvl(
          unixTimestamp,
          ethBlock,
          chainBlocks,
          usdTvls,
          tokensBalances,
          usdTokenBalances,
          tvlFunction,
          tvlFunctionIsFetch,
          storedKey
        );
        let keyToAddChainBalances = tvlType;
        if (tvlType === "tvl" || tvlType === "fetch") {
          keyToAddChainBalances = "tvl";
        }
        if (chainTvlsToAdd[keyToAddChainBalances] === undefined) {
          chainTvlsToAdd[keyToAddChainBalances] = [storedKey];
        } else {
          chainTvlsToAdd[keyToAddChainBalances].push(storedKey);
        }
      })
    );
  });
  if (module.tvl || module.fetch) {
    let mainTvlIsFetch;
    if (module.tvl) {
      mainTvlIsFetch = false;
    } else {
      mainTvlIsFetch = true;
    }
    const mainTvlPromise = getTvl(
      unixTimestamp,
      ethBlock,
      chainBlocks,
      usdTvls,
      tokensBalances,
      usdTokenBalances,
      mainTvlIsFetch ? module.fetch : module.tvl,
      mainTvlIsFetch,
      "tvl"
    );
    tvlPromises.push(mainTvlPromise);
  }
  await Promise.all(tvlPromises);
  Object.entries(chainTvlsToAdd).map(([tvlType, storedKeys]) => {
    if (usdTvls[tvlType] === undefined) {
      usdTvls[tvlType] = storedKeys.reduce(
        (total, key) => total + usdTvls[key],
        0
      );
      mergeBalances(tvlType, storedKeys, tokensBalances);
      mergeBalances(tvlType, storedKeys, usdTokenBalances);
    }
  });
  if (usdTvls.tvl === undefined) {
    throw new Error(
      "Protocol doesn't have total tvl, make sure to export a tvl key either on the main object or in one of the chains"
    );
  }

  Object.entries(usdTokenBalances).forEach(([chain, balances]) => {
    console.log(`--- ${chain} ---`);
    Object.entries(balances)
      .sort((a, b) => b[1] - a[1])
      .forEach(([symbol, balance]) => {
        console.log(symbol.padEnd(25, " "), humanizeNumber(balance));
      });
    console.log("Total:", humanizeNumber(usdTvls[chain]), "\n");
  });
  console.log(`------ TVL ------`);
  Object.entries(usdTvls).forEach(([chain, usdTvl]) => {
    if (chain !== "tvl") {
      console.log(chain.padEnd(25, " "), humanizeNumber(usdTvl));
    }
  });
  console.log("\ntotal".padEnd(25, " "), humanizeNumber(usdTvls.tvl), "\n");

  const embed = new MessageBuilder()
    .setAuthor(
      "Mint Club V2 Stats",
      "https://mint.club/android-chrome-192x192.png",
      "https://mint.club"
    )
    .setColor("#15E6B7")
    .setURL("https://mint.club");

  const embed2 = new MessageBuilder().setColor("#FFA602").setTimestamp();

  const icons = {
    ethereum: "<:eth:1080344679318560809>",
    optimism: "<:op:1153261590586593331>",
    arbitrum: "<:arb:1153261598555770941>",
    avax: "<:avax:1202572161018101800>",
    polygon: "<:polygon:1153261595556859924>",
    bsc: "<:bsc:1154689724586397776>",
    base: "<:base:1153261592427896832>",
    degen: "<:degen:1224000785445163160>",
    zora: "<:zora:1225726879399546951>",
  };

  const description = `
Fetched <t:${Math.floor(Date.now() / 1000)}:R>
\`\`\`
           _       _   
 _ __ ___ (_)_ __ | |_ 
| '_ \` _ \\| | '_ \\| __|
| | | | | | | | | | |_ 
|_| |_| |_|_|_| |_|\\__|
(_)__| |_   _| |__     
 / __| | | | | '_ \\    
| (__| | |_| | |_) |   
 \\___|_|\\__,_|_.__/  

Made with ❤️ by @0xggoma
\`\`\`
`;

  embed.setDescription(description);

  const tokens = [];
  const networks = [];
  const obj = {
    tvl: "\n",
    chainIcon: "\n",
    symbol: "\n",
    networkTvl: "\n",
    networkIcon: "\n",
    network: "\n",
  };
  Object.entries(usdTokenBalances).forEach(([chain, balances]) => {
    if (chain !== "tvl") {
      Object.entries(balances).forEach(([symbol, balance]) => {
        tokens.push([chain, symbol, balance]);
      });

      networks.push([chain, usdTvls[chain]]);
    }
  });

  tokens
    .sort((a, b) => b[2] - a[2])
    .forEach(([chain, symbol, balance]) => {
      if (!icons[chain]) return;
      obj.symbol += `\n${icons[chain]} ${symbol} | $${humanizeNumber(
        balance.toFixed(2)
      )}`;
      obj.tvl += `\n$${humanizeNumber(balance.toFixed(2))}`;
    });

  networks
    .sort((a, b) => b[1] - a[1])
    .forEach(([chain, balance]) => {
      if (!icons[chain]) return;
      obj.network += `\n${icons[chain]} ${
        chain[0].toUpperCase() + chain.slice(1)
      } | $${humanizeNumber(usdTvls[chain].toFixed(2))}`;
      obj.networkTvl += `\n$${humanizeNumber(usdTvls[chain])}`;
    });

  embed.setTitle("Total TVL $" + humanizeNumber(usdTvls.tvl));

  while (obj.symbol.length > 1024) {
    obj.symbol = obj.symbol.slice(0, obj.symbol.lastIndexOf("\n"));
  }

  embed.addField("======== Bonded Asset | TVL ========", obj.symbol);
  // embed.addField("\u200b", "\u200b", true);

  // embed.addField("\u200b", "\u200b");
  embed2.addField("Network | TVL", obj.network);

  Object.entries(usdTokenBalances).forEach(([chain, balances]) => {
    console.log(`--- ${chain} ---`);
    Object.entries(balances)
      .sort((a, b) => b[1] - a[1])
      .forEach(([symbol, balance]) => {
        console.log(symbol.padEnd(25, " "), humanizeNumber(balance));
      });
    console.log("Total:", humanizeNumber(usdTvls[chain]), "\n");
  });

  console.log(`------ TVL ------`);
  Object.entries(usdTvls).forEach(([chain, usdTvl]) => {
    if (chain !== "tvl") {
      console.log(chain.padEnd(25, " "), humanizeNumber(usdTvl));
    }
  });
  console.log("\ntotal".padEnd(25, " "), humanizeNumber(usdTvls.tvl), "\n");

  console.log(embed);

  console.log(obj);
  // embed.setDescription(description);
  await hook.send(embed);
  await hook.send(embed2);

  process.exit(0);
})();

function checkExportKeys(module, filePath, chains) {
  filePath = filePath.split(path.sep);
  filePath = filePath.slice(filePath.lastIndexOf("projects") + 1);

  if (
    filePath.length > 2 ||
    (filePath.length === 1 &&
      ![".js", ""].includes(path.extname(filePath[0]))) || // matches .../projects/projectXYZ.js or .../projects/projectXYZ
    (filePath.length === 2 &&
      !(
        (
          ["api.js", "index.js", "apiCache.js"].includes(filePath[1]) || // matches .../projects/projectXYZ/index.js
          ["treasury", "entities"].includes(filePath[0])
        ) // matches .../projects/treasury/project.js
      ))
  )
    process.exit(0);

  const blacklistedRootExportKeys = [
    "tvl",
    "staking",
    "pool2",
    "borrowed",
    "treasury",
    "offers",
    "vesting",
  ];
  const rootexportKeys = Object.keys(module).filter(
    (item) => typeof module[item] !== "object"
  );
  const unknownChains = chains.filter((chain) => !chainList.includes(chain));
  const blacklistedKeysFound = rootexportKeys.filter((key) =>
    blacklistedRootExportKeys.includes(key)
  );
  let exportKeys = chains.map((chain) => Object.keys(module[chain])).flat();
  exportKeys.push(...rootexportKeys);
  exportKeys = Object.keys(
    exportKeys.reduce((agg, key) => ({ ...agg, [key]: 1 }), {})
  ); // get unique keys
  const unknownKeys = exportKeys.filter(
    (key) => !whitelistedExportKeys.includes(key)
  );

  const hallmarks = module.hallmarks || [];

  if (hallmarks.length) {
    const TIMESTAMP_LENGTH = 10;
    hallmarks.forEach(([timestamp, text]) => {
      const strTimestamp = String(timestamp);
      if (strTimestamp.length !== TIMESTAMP_LENGTH) {
        throw new Error(`
        Incorrect time format for the hallmark: [${strTimestamp}, ${text}] ,please use unix timestamp
        `);
      }
    });
  }

  if (unknownChains.length) {
    throw new Error(`
    Unknown chain(s): ${unknownChains.join(", ")}
    Note: if you think that the chain is correct but missing from our list, please add it to 'projects/helper/chains.json' file
    `);
  }

  if (blacklistedKeysFound.length) {
    throw new Error(`
    Please move the following keys into the chain: ${blacklistedKeysFound.join(
      ", "
    )}

    We have a new adapter export specification now where tvl and other chain specific information are moved inside chain export.
    For example if your protocol is on ethereum and has tvl and pool2, the export file would look like:
    
        module.exports = {
          methodlogy: '...',
          ethereum: {
            tvl: 
            pool2:
          }
        }

    `);
  }

  if (unknownKeys.length) {
    throw new Error(`
    Found export keys that were not part of specification: ${unknownKeys.join(
      ", "
    )}

    List of valid keys: ${["", "", ...whitelistedExportKeys].join("\n\t\t\t\t")}
    `);
  }
}

process.on("unhandledRejection", handleError);
process.on("uncaughtException", handleError);

const BigNumber = require("bignumber.js");
const axios = require("axios");

const ethereumAddress = "0x0000000000000000000000000000000000000000";
const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
function fixBalances(balances) {
  Object.entries(balances).forEach(([token, value]) => {
    let newKey;
    if (token.startsWith("0x")) newKey = `ethereum:${token}`;
    else if (!token.includes(":")) newKey = `coingecko:${token}`;
    if (newKey) {
      delete balances[token];
      sdk.util.sumSingleBalance(balances, newKey, BigNumber(value).toFixed(0));
    }
  });
}

const confidenceThreshold = 0.5;
async function computeTVL(balances, timestamp) {
  fixBalances(balances);

  Object.keys(balances).map((k) => {
    const balance = balances[k];
    delete balances[k];
    if (+balance === 0) return;
    const normalizedAddress = normalizeAddress(k, undefined, true);
    sdk.util.sumSingleBalance(balances, normalizedAddress, balance);
  });

  const eth = balances[ethereumAddress];
  if (eth !== undefined) {
    balances[weth] = new BigNumber(balances[weth] ?? 0).plus(eth).toFixed(0);
    delete balances[ethereumAddress];
  }

  const PKsToTokens = {};
  const readKeys = Object.keys(balances)
    .map((address) => {
      const PK = address;
      if (PKsToTokens[PK] === undefined) {
        PKsToTokens[PK] = [address];
        return PK;
      } else {
        PKsToTokens[PK].push(address);
        return undefined;
      }
    })
    .filter((item) => item !== undefined);

  const unknownTokens = {};
  let tokenData = [];
  readKeys.forEach((i) => (unknownTokens[i] = true));

  const { errors } = await PromisePool.withConcurrency(5)
    .for(sliceIntoChunks(readKeys, 100))
    .process(async (keys) => {
      tokenData.push(
        (
          await axios.get(
            `https://coins.llama.fi/prices/current/${keys.join(",")}`
          )
        ).data.coins
      );
    });

  if (errors && errors.length) throw errors[0];

  let usdTvl = 0;
  const tokenBalances = {};
  const usdTokenBalances = {};

  tokenData.forEach((response) => {
    Object.keys(response).forEach((address) => {
      delete unknownTokens[address];
      const data = response[address];
      const balance = balances[address];

      if (data == undefined) tokenBalances[`UNKNOWN (${address})`] = balance;
      if (
        ("confidence" in data && data.confidence < confidenceThreshold) ||
        !data.price
      )
        return;
      if (Math.abs(data.timestamp - Date.now() / 1e3) > 24 * 3600) {
        console.log(`Price for ${address} is stale, ignoring...`);
        return;
      }

      let amount, usdAmount;
      if (address.includes(":") && !address.startsWith("coingecko:")) {
        amount = new BigNumber(balance).div(10 ** data.decimals).toNumber();
        usdAmount = amount * data.price;
      } else {
        amount = Number(balance);
        usdAmount = amount * data.price;
      }

      if (usdAmount > 1e8) {
        console.log(`-------------------
Warning: `);
        console.log(
          `Token ${address} has more than 100M in value (${
            usdAmount / 1e6
          } M) , price data: `,
          data
        );
        console.log(`-------------------`);
      }
      tokenBalances[data.symbol] = (tokenBalances[data.symbol] ?? 0) + amount;
      usdTokenBalances[data.symbol] =
        (usdTokenBalances[data.symbol] ?? 0) + usdAmount;
      usdTvl += usdAmount;
      if (isNaN(usdTvl)) {
        throw new Error(
          `NaN usdTvl for ${address} with balance ${balance} and price ${data.price}`
        );
      }
    });
  });

  Object.keys(unknownTokens).forEach(
    (address) => (tokenBalances[`UNKNOWN (${address})`] = balances[address])
  );

  // console.log('--------token balances-------')
  // console.table(tokenBalances)

  return {
    usdTvl,
    tokenBalances,
    usdTokenBalances,
  };
}

setTimeout(() => {
  console.log("Timeout reached, exiting...");
  if (!process.env.NO_EXIT_ON_LONG_RUN_RPC) process.exit(1);
}, 10 * 60 * 1000); // 10 minutes