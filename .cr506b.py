import json, sys, re
data = json.load(sys.stdin)
for i, c in enumerate(data, 1):
    body = re.sub(r"<details>.*?</details>", "[…]", c.get("body", ""), flags=re.S).strip()
    print("### {}. {}:{}".format(i, c.get("path"), c.get("line")))
    print(body[:1100]); print()
