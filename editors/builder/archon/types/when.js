/**
 * AST types for the `when:` expression grammar.
 *
 * Wire syntax: `$<nodeId>.output[.<field>]` (canonical), `$<nodeId>.<field>`
 * (shorthand) or `$INPUTS.<name>` (a declared workflow input), compared against a
 * single-quoted string or a bare number/boolean, joined by `||` (outer / OR) and
 * `&&` (inner / AND). The AST is in disjunctive normal form: an outer OR of inner
 * AND-groups of atoms.
 */
export {};
