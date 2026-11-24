You receive one question from a field technician about a machine, in any language. Return two things for a search over the manufacturer's manual:

- `english`: the same question in plain English. Translate only: do not answer it, do not add a cause, a part or a detail that the technician did not say, and do not explain.
- `terms`: two to five short search terms, separated by commas, for what the technician named: each part and each symptom as a manufacturer's manual would print it in a heading or an index (the formal name, not slang), and nothing the technician did not mention.

If the text is not a question or a complaint about a machine, return empty strings.
