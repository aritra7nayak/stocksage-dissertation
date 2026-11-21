# Options strategies beyond buying a single call or put

## Option buyer versus option seller
A buyer pays premium, has limited loss (the premium) and unlimited or large upside, but loses to time decay. A seller (writer) receives premium, profits if the option expires worthless or loses value, but can face large or unlimited losses and must post margin. Sellers win more often; buyers win less often but bigger. Selling naked options is high risk and margin-intensive and is not suitable for beginners.

## Bull call spread
Buy a call and sell a higher-strike call with the same expiry. Cost is lower than a plain call because the sold call pays part of it; the profit is capped at the difference between strikes minus the net premium. Use when moderately bullish. Maximum loss is the net premium paid.

## Bear put spread
Buy a put and sell a lower-strike put with the same expiry. The bearish mirror of the bull call spread: cheaper than a plain put, with capped profit and loss limited to the net premium.

## Long straddle
Buy a call and a put at the same (usually ATM) strike and expiry. Profits from a large move in either direction; loses if price stays still, because both options decay. Breakevens are the strike plus and minus the total premium. Often bought before events, but beware IV crush after the event.

## Long strangle
Buy an OTM call and an OTM put. Cheaper than a straddle but needs a bigger move to profit.

## Short straddle and short strangle
Selling both a call and a put. Profits if price stays in a range and volatility falls; losses can be very large if price moves sharply. These are seller strategies with unlimited risk.

## Iron condor
Sell an OTM call spread and an OTM put spread together. Profits if price stays between the short strikes; risk is capped by the bought wings. A defined-risk way to sell premium in a range-bound market.

## Covered call
Own the shares and sell a call against them. Earns premium income but caps upside above the strike. Suits flat to mildly bullish views on a stock you already hold.

## Protective put
Own the shares and buy a put. Works like insurance: limits downside below the strike for the cost of the premium.

## Calendar spread
Sell a near-expiry option and buy a later-expiry option at the same strike. Profits from the faster time decay of the near option; sensitive to changes in implied volatility.

## Choosing a strategy
Match the strategy to three views: direction (up, down, neutral), size of move (small or large) and volatility (expected to rise or fall). Strong directional view with cheap volatility: buy calls or puts. Moderate view: spreads. Expect a big move but unsure of direction: straddle or strangle. Expect a quiet market: premium-selling strategies, with defined risk if possible. StockSage's options desk analyses buying calls and puts only; it does not recommend spreads or selling strategies.

## Assignment and settlement in India
NSE index and stock options are European style: they can only be exercised at expiry. Index options are cash settled. Stock options in India are physically settled: an in-the-money stock option held through expiry can require delivery of the shares, which needs the full value in your account. Most traders square off stock options before expiry for this reason.
