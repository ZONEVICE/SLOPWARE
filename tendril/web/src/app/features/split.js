/**
 * Editor groups (workbench/groups.js): split the editor area in two, move
 * editors between the groups, focus the other one and join them back. Not
 * available on phones and narrow windows, where there is room for one.
 */
import { isNarrow } from '../core/dom.js';

export function register(app) {
  const groups = app.groups;
  const wide = () => !isNarrow();
  const c = (def) => app.commands.register({ category: 'View', ...def });

  c({
    id: 'view.splitEditor',
    title: 'Split Editor',
    icon: 'split',
    keys: 'Mod+\\',
    when: () => wide() && !!app.tabs.activeDoc,
    run: () => groups.split(),
  });
  c({
    id: 'view.moveEditorToOtherGroup',
    title: 'Move Editor into Other Group',
    when: () => wide() && !!app.tabs.active,
    run: () => groups.moveActive(),
  });
  c({ id: 'view.focusOtherGroup', title: 'Focus Other Editor Group', when: () => groups.count > 1, run: () => groups.focusOther() });
  c({ id: 'view.joinGroups', title: 'Join Editor Groups', when: () => groups.count > 1, run: () => groups.join() });

  const add = (command, order) => app.menus.add('view', { command, group: '4_groups', order });
  add('view.splitEditor', 1);
  add('view.moveEditorToOtherGroup', 2);
  add('view.focusOtherGroup', 3);
  add('view.joinGroups', 4);

  // A button at the right of each tab strip, as in VS Code.
  groups.addAction({ command: 'view.splitEditor', icon: 'split', title: 'Split Editor', when: (tab) => wide() && !!tab?.doc });
  window.matchMedia('(max-width: 767px)').addEventListener('change', () => groups.refreshActions());
}
