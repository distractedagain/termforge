# Tab groups and snapshots

TermForge 0.5 adds independent tab groups. Each group shows its selected terminal; the focused group determines where keyboard input and active-session commands go. The existing broadcast control still targets all live connections after review.

## Arrange terminals

Open two or more tabs, select a tab, then choose **Window → New Vertical Tab Group** to place it beside its current group, or **New Horizontal Tab Group** to place it below. A group needs another tab to leave behind when splitting its selected tab.

Drag tabs to reorder them or move them to another group's tab strip. **Move Tab to Next Group** provides a menu alternative. Moving a tab keeps the terminal process and its output. **Collapse Tab Groups** combines the tabs into one group.

Drag a divider to resize a split. Focus a divider and use its arrow keys for keyboard resizing. Ratios are constrained to keep both sides usable. **Tile Horizontally**, **Tile Vertically**, and **Tile as Grid** distribute open connections into groups with one tab each. You can add more tabs to any group afterward.

Closing the last tab in a group removes that group and its divider. Reconnecting replaces the connection in its existing group. A group can retain a terminal that has exited, with its output available until closed.

## Save and restore a workspace

Choose **Window → Snapshots…**, enter a name, and select **Save current**. A snapshot stores:

- Each open saved-session instance, including multiple connections to the same profile.
- Tab order and the selected tab in each group.
- The split arrangement, relative divider sizes, and focused group.

Snapshots hold up to 32 saved connections. Unsaved quick connections and local shells must first have saved profiles to be included. The dialog reports excluded connections. Terminal output, process state and authentication are not stored. A restored connection uses the saved profile's current settings.

**Select** highlights the snapshot's profiles in the Session Manager without connecting or rearranging open terminals. **Connect…** shows the connection targets for review and opens each instance after confirmation. The restored layout is added beside existing tabs. If a connection fails to open, the others remain available; empty groups are removed and the result reports the number opened and failed. Authentication or later transport failures still appear in their respective terminals.

Existing snapshots remain readable. Older snapshots contain one connection per profile and their original basic tile settings; they cannot recover instances or geometry that were never saved. Saving them again by the same name replaces them with the richer format after confirmation. Deleting a profile removes its instances from stored snapshots and repairs the remaining layout. JSON import remaps colliding profile IDs in every instance. TermForge 0.4 and earlier cannot read the new snapshot fields, so retain a configuration export from the older version if you plan to downgrade.

This is an independent implementation. Moving live tabs between application windows, selected-group command broadcasting, automatic workspace restoration at startup, floating managers, and complete SecureCRT layout equivalence remain outside this version.
