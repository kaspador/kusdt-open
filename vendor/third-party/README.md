# Third-party data

`kaspire-kcc20_standard_template.json`: the standard KCC-20 template (its script prefix and suffix, as hex), as the
Kaspire wallet ships it, from kcc20-reference commit `c8a087117735a1f87c5c6d115fcddeaf2562c784`. Data, not code.

`bridge/kaspa/tests/template.rs` compiles kUSDT and checks that its `KCC20` actor is byte for byte this template, so that
wallets and indexers which already accept KCC-20 tokens recognise kUSDT's states.
