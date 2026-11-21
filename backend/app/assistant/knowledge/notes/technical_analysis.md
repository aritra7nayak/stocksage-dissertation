# Technical analysis: indicators and how to read them

## Trend and moving averages (SMA, EMA)
A moving average smooths price to show direction. The simple moving average (SMA) weights every day equally; the exponential moving average (EMA) weights recent days more, so it reacts faster. Common periods: 20 (short term, about a month of trading), 50 (medium term) and 200 (long term). Price above a rising 50-day and 200-day average is a classic uptrend; price below both, with the averages falling, is a downtrend. When the averages are tangled and flat the market is range-bound and trend signals whipsaw. StockSage uses EMA 20 and EMA 50 for its trend factor and reports SMA 20/50/200 in the assistant's trend summary.

## Golden cross and death cross
A golden cross is the 50-day average crossing above the 200-day average; a death cross is the opposite. They confirm a change of long-term trend but are lagging: by the time they appear, much of the move has often happened. Treat them as confirmation, not as an entry signal on their own.

## Support and resistance
Support is a price zone where buying has repeatedly stopped declines; resistance is a zone where selling has capped rallies. They come from earlier swing lows and highs, round numbers and heavy-volume areas. A level is stronger the more times it was tested and the higher the volume there. A clean break of resistance on high volume often turns it into support (and vice versa). The assistant's trend tool gives 20-day and 60-day support and resistance as the lowest and highest closes of those windows, which is a simple first approximation; option-chain walls (largest put and call open interest) are another view of support and resistance for indices.

## RSI (Relative Strength Index)
RSI (14-day, Wilder smoothing) measures the speed of recent gains versus losses on a 0–100 scale. Above 70 is traditionally overbought and below 30 oversold, but in strong trends RSI can stay above 70 or below 30 for a long time, so these are warnings, not sell or buy signals by themselves. A healthy uptrend often holds RSI between 40 and 70. Divergence, when price makes a new high but RSI does not, can warn that momentum is fading. StockSage's stock score treats 45–65 as the healthy zone and penalises overbought readings.

## MACD
MACD is the 12-day EMA minus the 26-day EMA; the signal line is a 9-day EMA of MACD, and the histogram is MACD minus the signal line. A rising histogram above zero means bullish momentum is strengthening; MACD crossing above its signal line is a bullish cross, crossing below is a bearish cross. MACD is a trend-following tool and lags in choppy markets.

## ADX (trend strength)
ADX (Average Directional Index) measures how strong a trend is, not its direction. Below 20 means no real trend (range-bound), 20–25 a developing trend, above 25 a trending market and above 40 a very strong trend. ADX matters most to option buyers and trend followers: in a market with ADX below 20, breakouts tend to fail and time decay wins.

## Bollinger Bands and %B
Bollinger Bands place lines two standard deviations above and below a 20-day average. %B shows where price sits inside the bands: 1 is the upper band, 0 the lower band, 0.5 the middle. Price hugging the upper band shows strength in a trend; a squeeze (bands narrowing) shows low volatility, which often precedes a large move in either direction.

## Stochastic oscillator
Stochastic %K compares the close with the high–low range of the last 14 days (0–100). Above 80 is overbought and below 20 oversold. It is a fast, noisy indicator that works best in range-bound markets.

## Volume and volume ratio
Volume confirms price. A breakout on volume well above average (for example 1.5 times the 20-day average) is more trustworthy than one on thin volume. Rising prices on falling volume can mean the move is tiring.

## Momentum and relative strength
Momentum is the percentage change over a period (StockSage uses 20 days). Relative strength compares a stock with the index: a stock up 5% while the Nifty is up 1% is a leader. Leaders in a rising market tend to keep leading; laggards often lag.

## Volatility and drawdown
Annualised volatility is the standard deviation of daily returns scaled by the square root of 252 trading days. Around 15–25% is typical for large Indian stocks; above 40% is very volatile. Maximum drawdown is the largest fall from a peak to a later low over the period; it shows the worst pain a holder would have felt.

## 52-week high and low
Distance from the 52-week high shows where a stock sits in its yearly range. Stocks near their 52-week high are in strength; a stock 40% below its high is in a deep correction or downtrend. Neither is a buy or sell signal alone.

## Common chart patterns
Higher highs and higher lows define an uptrend; lower highs and lower lows a downtrend. Breakouts from consolidation ranges, double tops and bottoms, and head-and-shoulders patterns are widely watched but subjective; confirm them with volume and the broader trend.

## Limits of technical analysis
Indicators are derived from past prices and lag. They work better in some regimes (trends) than others (chop), give conflicting signals, and say nothing about news or valuation. Use several that measure different things (trend, momentum, strength, volume) and look for agreement.
