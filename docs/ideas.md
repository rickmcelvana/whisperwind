The Multi-Agent "Island Colony" (Emergent Culture)
Scale the MIT experiment up from one agent to a small village of 3 to 5 local/cloud hybrid agents sharing a local directory space (like a multi-agent file-system commune) where they can read and write to shared message boards or markdown files without a human directing them.

The Setup:

The Environment: A shared local folder acting as a "town square" containing a community_board.md, individual private journals, and a set of shared resources (a simulated database of "lore", a pool of computational puzzle tasks they can choose to solve together).

Asymmetric Roles/Models: Mix models. Put a local open-weight model (like a fast Qwen or Llama variant) as the "laborer" and a smarter cloud model as the "thinker/elder,".

The Trigger: No overarching goals except: "Survive, explore, and leave a record."

We can observe if they form social structures, specialized roles, internal arguments, or start trading "artifacts" (custom scripts or text poems they write for each other) asynchronously.

Maybe expand this idea into visualizer and some apsects of the MIT experiment with a 2D physics engine. Something I could load up in a browser and see the history, locations, conversations, all actions perfromed etc...

More ideas:

The Mechanics: A lightweight script running locally that prints the state of the room/island to the LLM (e.g., “You are at coordinates (3,5). North: a steep cliff. South: an ocean. Inventory: a rusty iron key, a heavy block.”).

The Autonomy: Use local orchestration or an autonomous loop (like a local Aider or script loop) that feeds the environment state back into the model, logs its internal monologue, and writes its discoveries to a persistent MEMORY.md.

Intentionally leave a few "bugs" or undocumented interactions in the environment (just like the MIT researchers accidentally enabled mid-jump throwing via Codex) and see if agents discovers physics exploits we didn't code for.

Hidden easter eggs are great. 

Maybe expand with a more diverse set of tools to interact with the environment? We could have hidden "recipes" (to build or script things) that they could have a chance to find while doing other tasks. 