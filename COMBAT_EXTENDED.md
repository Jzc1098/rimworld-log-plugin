# Combat Extended 兼容手册

给 RimWorld 1.6 的第三方武器/护甲做 CE 兼容时，需要知道的运行机制、排查顺序和已验证的坑。

本文的每一条结论都来自对 `CombatExtended.dll` 的反编译（证据留在 `mod工作区\_work\CE-*.cs`）和实机验证，不是从论坛或印象来的。凡是推断，都会标出来。

**专有名词一律写成「中文（English）」**，和本仓其它文档一致。

---

## 0. 先记住这一条

> **CE 不是一层。它是三套互相独立的转换。**

这是本仓花掉最多时间的一个认知修正。CE 对弹药、近战和数据各不相同地介入，**把一个武器「CE 化」需要分别处理，缺一项不会报错，但会在特定时机以别处的问题形式暴露出来。**

| 系统 | 负责的东西 | 没做会怎样 |
|---|---|---|
| **弹道系统** | 远程武器飞行、命中、护甲穿透 | 弹丸走原版飞行，**不享受也不受制于 CE 弹道**；不报错 |
| **近战系统** | `ToolCE`、`MeleeDamageAverage` | 面板近战伤害显示 **0**，日志报错；**实际伤害仍正常** |
| **护甲系统** | 穿透值来源与兜底 | 静默取兜底值，或打出 `has null verb` 警告 |

所以任何一次「这个武器在 CE 下怪怪的」，第一步是问：**它的哪个部分没有 CE 数据？**

---

## 1. 护甲穿透的取值链（最重要的一段）

代码位置：`CombatExtended.ArmorUtilityCE.GetDeflectDamageInfo`（证据：`_work\CE-ArmorUtilityCE.cs` 第 359 行起）。

```csharp
private static DamageInfo GetDeflectDamageInfo(DamageInfo dinfo, BodyPartRecord hitPart,
                                              ref float dmgAmount, ref float penAmount,
                                              bool partialPen = false)
{
    if (dinfo.Def.armorCategory != DamageArmorCategoryDefOf.Sharp)
    {
        // 非锐器伤害：直接返回，不走穿透计算
        if (!partialPen) { dmgAmount = 0f; penAmount = 0f; }
        dinfo.SetAmount(0f);
        return dinfo;
    }

    float num  = dmgAmount;
    float num2 = penAmount;
    float num3 = (partialPen ? ((dinfo.ArmorPenetrationInt - num2) * (dinfo.Amount - num)
                                / dinfo.Amount)
                             : num2) / dinfo.ArmorPenetrationInt;

    if (dinfo.Weapon?.projectile is ProjectilePropertiesCE projectilePropertiesCE)
        num2 = projectilePropertiesCE.armorPenetrationBlunt * num3;          // ①
    else if (dinfo.Instigator?.def.thingClass == typeof(Building_TrapDamager))
        num2 = dinfo.Instigator.GetStatValue(StatDefOf.TrapMeleeDamage) * 0.65f;  // ②
    else if (Verb_MeleeAttackCE.LastAttackVerb != null)
        num2 = Verb_MeleeAttackCE.LastAttackVerb.ArmorPenetrationBlunt;      // ③
    else if (dinfo.defInt.defaultArmorPenetration > 0f)
        num2 = dinfo.defInt.defaultArmorPenetration;                        // ④
    else
    {
        Log.Warning($"[CE] Deflection for Instigator:{dinfo.Instigator} ... has null verb, overriding AP.");
        num2 = 50f;                                                         // ⑤
    }
    ...
}
```

### 读这条链要抓住的四件事

**① 出口只有五个，而且是有顺序的** —— 命中哪个出口，决定了这个武器的穿透从哪来。**排在前面的条件满足后，后面的全都不会执行。**

**② 第 ⑤ 条那个 `50f` 是一个假定值，不是设计值。** 它是「实在查不到，就用 50」的兜底。看到 `has null verb` 警告，意思不是「缺一个字段」，而是「**CE 不知道这个武器该有多少穿透，于是替它猜了一个**」。50 这个数能破掉绝大多数动力甲，所以它的实战后果是**这个武器比它应有的强度更能穿甲**。

**③ 第 ⑤ 条要求 `armorCategory == Sharp`。** 所以用 `Blunt` 伤害类型的武器**永远不会**触发这条警告 —— 它在函数开头就返回了。排查时先看 `DamageDef.armorCategory`，能省掉一大半误判。

**④ 第 ④ 条是唯一一个「改数据就能修」的出口。** 如果某个 `DamageDef` 的 `defaultArmorPenetration` 是 `-1f`（这是 `Verse.DamageDef` 的字段默认值），它就会落到第 ⑤ 条。**给该 `DamageDef` 设一个正的 `defaultArmorPenetration`，警告就从根上消失**，而且作用范围正好是「用这个伤害类型的一切东西」。

### 一个反直觉的推论

**`DamageDef` 是公共资源。** 给原版 `Cut` 设 `defaultArmorPenetration` 会影响**所有**用 `Cut` 的东西，不只是你想修的那把武器。所以：

- **mod 自己的 `DamageDef`** → 放心改（`fix-dragonian-ce-damagedef` 就是这么做的）
- **原版 `DamageDef`** → 改之前先想清楚波及面；能不动就不动

CE 自己**没有**给原版 `Cut` 设这个值（扫过 CE 全部补丁，`DamageDef` 里只有 `Electrical` 和 `CE_Laser` 两处设了 `defaultArmorPenetration`）。所以拿 `Cut` 当锐器伤害、又不是 `ToolCE`、又不是 `ProjectilePropertiesCE` 的武器，**必然**落到第 ⑤ 条。这是 CE 的既有缺口，不是你漏配了什么。

---

## 2. 近战武器：`ToolCE`

代码位置：`CombatExtended.ToolCE`（证据：`_work\CE-ToolCE.cs`）。

```csharp
public class ToolCE : Tool
{
    public float armorPenetrationSharp;
    public float armorPenetrationBlunt;
    public Gender restrictedGender = Gender.None;
    public AttachmentDef requiredAttachment = null;
}
```

**关键结构事实：`ToolCE` 继承原版 `Verse.Tool`。** 所以原版的这些字段在 CE 格式下**依然有效**：

```
label, labelNoLocation, untranslatedLabel, labelUsedInLogging
capacities, power, armorPenetration, cooldownTime, chanceFactor
surpriseAttack, hediff, alwaysTreatAsWeapon, extraMeleeDamages
soundMeleeHit, soundMeleeMiss, linkedBodyPartsGroup
ensureLinkedBodyPartsGroupAlwaysUsable
```

**这条推论很实用**：把原版 `tools` 转成 CE 格式时，`power`、`cooldownTime`、`soundMeleeHit`、`linkedBodyPartsGroup` 都可以**原样保留**，只需要：

1. 给 `<li>` 加 `Class="CombatExtended.ToolCE"`
2. 补 `armorPenetrationSharp` / `armorPenetrationBlunt`

**这解释了为什么 CE 官方给原版近战武器打补丁时 `power` 一个都不改**（见 `Patches\Core\ThingDefs_Misc\Weapons_Melee.xml`）：它只补 CE 需要的字段，不动既有手感。

### `MeleeDamageAverage` 为什么显示 0

代码位置：`CombatExtended.StatWorker_MeleeDamageAverage.GetValueUnfinalized`（证据：`_work\CE-StatWorker_MeleeDamageAverage.cs`）。

```csharp
List<Tool> thingDefTools = CE_Utility.GetThingDefTools(req.Def as ThingDef);
if (thingDefTools.NullOrEmpty()) return 0f;

if (thingDefTools.Any((Tool x) => !(x is ToolCE)))
{
    Log.Error("Trying to get stat MeleeDamageAverage from " + req.Def.defName
              + " which has no support for Combat Extended.");
    return 0f;
}
```

**注意它检查的是「任意一个 tool 不是 `ToolCE`」** —— 一把武器只要有一个 tool 没转，整条属性就返回 0。

### 但这个 0 **不影响实际砍人**

实际近战伤害走的是另一条路：

```csharp
// Verb_MeleeAttackCE.DamageInfosToApply
float damAmount = verbProps.AdjustedMeleeDamageAmount(this, CasterPawn);
```

**`MeleeDamageAverage` 在整个 `CombatExtended.dll` 里只出现在它自己的 `StatWorker` 中，`Verb_MeleeAttackCE` 一次都不引用它。**

所以那个错误的实际后果是：

| 后果 | 有吗 |
|---|---|
| 武器信息面板「近战伤害」显示 0 | ✅ 有 |
| 每次会话两条 `Log.Error` | ✅ 有 |
| 砍不动人 / 伤害不对 | ❌ **没有** |

**判定方法**：看到这条错误，先确认「面板显示」还是「实战伤害」。**只有面板和日志受影响时，这是一个低优先级问题**；但如果同时还有其他武器参与 CE 护甲结算，那些武器的穿透值要走第 1 节的链，那才是会影响实战的部分。

---

## 3. 远程武器：两套写法

### 3.1 `PatchOperationMakeGunCECompatible`（CE 官方提供的操作）

代码位置：`CombatExtended.PatchOperationMakeGunCECompatible`（证据：`_work\CE-MakeGunCECompatible.cs`）。

它接受这些顶层节点：

```xml
<Operation Class="CombatExtended.PatchOperationMakeGunCECompatible">
  <defName>你的武器 defName</defName>
  <statBases>  <SightsEfficiency/> <ShotSpread/> <SwayFactor/> <Bulk/>
               <RangedWeapon_Cooldown/> </statBases>
  <Properties> <verbClass/> <hasStandardCommand/> <defaultProjectile/>
               <warmupTime/> <range/> <burstShotCount/> <ticksBetweenBurstShots/>
               <soundCast/> <muzzleFlashScale/> </Properties>
  <AmmoUser>   <magazineSize/> <reloadTime/> <ammoSet/> </AmmoUser>
  <FireModes>  <aiAimMode/> </FireModes>
  <AllowWithRunAndGun>false</AllowWithRunAndGun>
</Operation>
```

### ★ 一个必须知道的副作用

```csharp
private void AddOrReplaceVerbPropertiesCE(XmlDocument xml, XmlNode xmlNode)
{
    if (GetOrCreateNode(xml, xmlNode, "verbs", out var output))
    {
        // 只匹配这三种 verbClass
        XmlNodeList xmlNodeList = output.SelectNodes(
            "li[verbClass=\"Verb_Shoot\" or verbClass=\"Verb_ShootOneUse\""
            + " or verbClass=\"Verb_LaunchProjectile\"]");
        ...
        // 然后【追加】一个新的 VerbPropertiesCE
        output.AppendChild(CreateListElementAndPopulate(
            xml, Properties.node, "CombatExtended.VerbPropertiesCE"));
    }
}
```

**它只替换 `verbClass` 正好是这三个值的 verb，其它一律不管，然后追加一个新的。**

**后果**：如果目标武器用的是自定义 verb（例如继承自 `Verb_Shoot` 的 `SomeMod.Verb_CustomShoot`），那么：

- 自定义 verb **不会被删掉**（它不匹配那三个字符串）
- CE 会**追加**一个 `VerbPropertiesCE`
- 结果这个武器**同时有两个 verb** → 可能出现双开火模式、AI 选错、UI 混乱

**这是静默的**，不报错。**处理办法**：先用 `PatchOperationRemove` 显式删掉 `verbs`，再用本操作写入 CE 的 verbs；或者确认双 verb 在你的场景下无害。

### 3.2 手写 Def（CE 补丁 mod 常用）

> **来源说明**：本节的字段和结构取自 **CE 本体的补丁文件**（`CombatExtended\Patches\Core\...`、`CombatExtended\ModPatches\...`）以及 CE 的 fork mod（`MoeLotl CE 1.6(Forked)` 里的 `AxolotlCE_LotiQiRangedWeapon.xml`）。
> **本仓自己写的 7 个 CE 补丁里没有任何远程武器字段** —— 它们只覆盖近战 `ToolCE` / `DamageDef` / `RecipeDef`。所以这一节是**读来的模式**，不是**实机验证过的模式**。用之前按第 7 节的流程自己验一遍。

CE 自己的 mod 补丁大多直接用 `PatchOperationReplace` 整块换掉 `verbs` 和 `tools`。这种做法更可控（你完全知道最终 XML 长什么样），代价是要自己写全 `VerbPropertiesCE` 的字段。

一个完整的参考实现（CE fork 里给一族武器做的转换，7 把武器共用一套结构）：

```xml
<!-- ① 删掉原版 verbs -->
<Operation Class="PatchOperationRemove">
  <xpath>Defs/ThingDef[defName="你的武器"]/verbs</xpath>
</Operation>

<!-- ② 加 CE 组件（可选，取决于该武器族需要什么） -->
<Operation Class="PatchOperationAdd">
  <xpath>Defs/ThingDef[defName="你的武器"]/comps</xpath>
  <value><li><compClass>该武器族的 CE 组件</compClass></li></value>
</Operation>

<!-- ③ 换成 CE 的 verb -->
<Operation Class="PatchOperationReplace">
  <xpath>Defs/ThingDef[defName="你的武器"]/verbs</xpath>
  <value>
    <verbs>
      <li Class="CombatExtended.VerbPropertiesCE">
        <verbClass>CombatExtended.Verb_ShootCE</verbClass>
        <hasStandardCommand>true</hasStandardCommand>
        <defaultProjectile>你的CE弹丸</defaultProjectile>
        <warmupTime>1</warmupTime>
        <range>18</range>
        <soundCast>...</soundCast>
      </li>
    </verbs>
  </value>
</Operation>

<!-- ④ tools 也要 CE 化，否则近战反击走第 1 节的兜底链 -->
<Operation Class="PatchOperationReplace">
  <xpath>Defs/ThingDef[defName="你的武器"]/tools</xpath>
  <value><tools><li Class="CombatExtended.ToolCE"> ... </li></tools></value>
</Operation>
```

弹丸和弹药：

```xml
<!-- 弹丸：ParentName 用 BaseBulletCE，projectile 必须是 ProjectilePropertiesCE -->
<ThingDef ParentName="BaseBulletCE">
  <defName>你的CE弹丸</defName>
  <projectile Class="CombatExtended.ProjectilePropertiesCE">
    <speed>98</speed>
    <damageAmountBase>30</damageAmountBase>
    <armorPenetrationSharp>5</armorPenetrationSharp>
    <armorPenetrationBlunt>40.8</armorPenetrationBlunt>
  </projectile>
</ThingDef>

<!-- 弹药集 -->
<CombatExtended.AmmoSetDef>
  <defName>你的弹药集</defName>
  <label>显示名</label>
  <ammoTypes>
    <Ammo_某弹种>你的CE弹丸</Ammo_某弹种>
  </ammoTypes>
</CombatExtended.AmmoSetDef>
```

**字段名的可靠性**：上面这些字段名来自 CE 的 patch XML 与 CE 的 C# 字段（`ProjectilePropertiesCE`、`VerbPropertiesCE`、`CompProperties_AmmoUser`）。**用之前仍要按第 7 节第 4 步离线校验每个字段名**，因为 `PatchOperationMakeGunCECompatible` 是按字符串拼 XML 的，写错的字段在游戏里表现为「加载失败」而不是「忽略」。

---

## 4. 「这个武器要不要 CE 化」的判断

**不要一看到 `has null verb` 就动手。** 先走这三步：

### 第一步：看它的 `DamageDef.armorCategory`

```
不是 Sharp  →  永远不会触发第 1 节那条链，不会报错，CE 化收益极低
是 Sharp    →  继续
```

**实测案例**：一个 mod 的三把远程武器分别用 `Blunt`（两把）和 `Stab`（一把）。`Blunt` 那两把**从头到尾没报过任何错**，因为它们根本进不到那段逻辑。当时我据「弹丸 `damageAmountBase` 很小」推断「这几个武器实战偏弱」，**结论是错的** —— 真实伤害写在它们各自的效果 Def 里（一个 50 单体、一个 30 半径 5 爆炸、还有 5 道闪电和控制效果），弹丸那个数字只是载体。

> **教训：判定「有没有伤害」要顺着代码找到真正施加伤害的那一行，不要停在数据表里最显眼的那个字段。**

### 第二步：看它的 `verbClass` 是什么

```
Verb_Shoot / Verb_ShootOneUse / Verb_LaunchProjectile  →  MakeGunCECompatible 能干净处理
自定义（继承自上面某个）                                →  见 3.1 的双 verb 副作用
```

**自定义 verb 通常承载着这个 mod 的核心机制**（变招、蓄力、弹种切换…）。CE 化会往同一个 `verbs` 列表里塞东西，**有砸掉机制的风险**。

### 第三步：看它的伤害是不是靠「非弹道」路径实现的

有些远程武器的威力全部来自自定义弹丸类的 `Impact` 里调用的 `GenExplosion.DoExplosion` / `TakeDamage`，弹丸本身只是触发器。这类武器 CE 化之后：

- 弹道确实进入 CE 体系了
- 但**主要伤害输出那部分本来就绕过了 CE 弹道**，改不改都一样
- 而且你还要处理「非伤害型弹丸」（造墙、拉人、位移）—— **这些在 CE 里没有对应概念，硬做会出问题**

**结论：收益低、风险高时，不做是正确决定。**

---

## 5. 已验证的坑

按坑的性质分三类。**每一条都是实际踩过并留下证据的。**

### 5.1 补丁写法类

| # | 坑 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | **xpath 用命令行传参** | 引号被 shell 吃掉 → `@Class=CombatExtended.ToolCE` → 匹配 0 个 → **看起来像「补丁生效了但没找到目标」** | **xpath 从文件读**，永不从命令行传 |
| 2 | **XML 属性名大小写** | ⚠️ **`@class`（小写）不是「匹配不到」，而是永远返回真** —— **失败开放**，比匹配不到更危险：它会让守卫静默失效，你以为转换过了其实没有 | 必须用 `@Class`。**写完守卫要实测命中数**，别假设 |
| 3 | **`PatchOperationRemove` 落空** | **会 `Log.Error`**，不是静默跳过 | 包在 `PatchOperationConditional`（`match` 里做删除）或 `PatchOperationFindMod` 里 |
| 4 | **`<value>` 嵌套层数** | 少一层 → `XML error: ... doesn't correspond to any field in type ...` | `DefModExtension` 那类列表字段要嵌**两层**：`<value><value>...</value></value>` |
| 5 | **About.xml 里的裸 `&`** | `分析 EntityName 时出错` → **mod 直接加载失败** | `&` 写成 `&amp;` |
| 6 | **About.xml 里的裸 `<`** | 同理：`开始标记 X 与结束标记 Y 不匹配` | 描述里引用 XML 片段要写成 `&lt;` |
| 7 | **`tools` 替换时漏掉 `Inherit="False"`** | 继承来的 `tools` 会和新的合并 → 工具数超出预期 | 整块替换时按需写 `<tools Inherit="False">`；本仓两个近战补丁一个写了一个没写，都验证过能跑，**差异来自父类是否自带领 tools** |

**第 3 条是最近才踩的，值得展开**：我写了一个「删掉某个不存在的类型引用」的补丁，在 `About.xml` 里注明「若该 mod 日后自己修好，xpath 落空则静默跳过」。**这个说法是错的。** 当那个 mod 的作者真的删掉了那些行，我的补丁每次启动都报两条 ERROR。

**正确写法**：

```xml
<!-- 只有在目标 mod 加载时才执行 -->
<Operation Class="PatchOperationFindMod">
  <mods><li>该mod的packageId</li></mods>
  <match Class="PatchOperationSequence">
    <operations>
      <li Class="PatchOperationRemove"><xpath>...</xpath></li>
    </operations>
  </match>
</Operation>
```

但注意：**「mod 加载了」和「那个节点存在」是两件事。** 更稳的是 `PatchOperationConditional`：

```xml
<Operation Class="PatchOperationConditional">
  <xpath>要删的节点</xpath>
  <match Class="PatchOperationRemove"><xpath>要删的节点</xpath></match>
</Operation>
```

### 5.2 CE 机制类

| # | 坑 | 机制 |
|---|---|---|
| 6 | 以为 `armorPenetration`（原版字段）CE 会读 | **不读。** CE 只看 第 1 节那条链 |
| 7 | 以为 `defaultArmorPenetration` 有默认值 | 是 `-1f`。≤ 0 就会落到第 ⑤ 条兜底 |
| 8 | 给原版 `DamageDef` 设穿透 | **波及所有用该伤害类型的东西**，不只是你想修的武器 |
| 9 | 以为自定义 verb 会被 `MakeGunCECompatible` 替换 | **不会被替换**，会被**追加**一个 CE verb → 双 verb |
| 10 | 以为 `MeleeDamageAverage = 0` 意味着打不出伤害 | 面板和日志受影响，**实战伤害走另一条路** |
| 11 | 以为一个 tool 转了就算 `ToolCE` 武器 | 检查是 **`Any(x => !(x is ToolCE))`** —— **有一个没转就整体算未支持** |

### 5.3 证据链类

| # | 坑 | 说明 |
|---|---|---|
| 12 | 只看数据表最显眼的字段就下结论 | 见第 4 节第一步那个案例：**真实伤害在效果 Def 里** |
| 13 | 用 `has null verb` 的出现次数衡量严重度 | 它是**兜底路径被走到**的次数，不是错误数。次数高只说明「很多次打在了没有 CE 数据的武器上」 |
| 14 | 相信「某个 mod 没做 CE 支持」这类印象 | **扫一遍比印象可靠**。本仓那次扫描的结论是「CE 完全没给原版 `Cut` 设穿透」，这才把注意力从「我漏配了」转到「这是 CE 的既有缺口」 |

---

## 6. 排查索引：症状 → 机制

| 日志里的症状 | 真实机制 | 去看 |
|---|---|---|
| `[CE] Deflection ... has null verb, overriding AP.` | 穿透落到兜底 `50f` | 第 1 节第 ⑤ 条 |
| `Trying to get stat MeleeDamageAverage from X which has no support for Combat Extended.` | 有 tool 不是 `ToolCE` | 第 2 节 |
| 武器面板近战伤害显示 0，但打得动 | 同上，且**不影响实战** | 第 2 节 |
| 远程武器 CE 化后出现两个开火模式 | `MakeGunCECompatible` 追加了第二个 verb | 第 3.1 节 |
| CE 化后伤害反而不对 | 主要伤害本来就不走弹道（自定义 `Impact`） | 第 4 节第三步 |
| `Exception loading def ... Could not find type named X` | 补丁引用了一个不存在的 C# 类型 | 见下方「相关手册」 |
| 加了 mod 后进不去主菜单、启用列表被清空 | 上述异常让游戏判定「核心之外还有模组」→ 重置 ModsConfig | 见下方「相关手册」 |

### 一个跨手册的因果链（本仓实际发生过）

```
某个 mod 的补丁引用了一个不存在的 C# 类型
  → def 解析抛 ArgumentException
    → 游戏判定「核心之外还有模组」→ Resetting mods config
      → 启用列表从 499 个被清成 6 个
        → 进不去主菜单
```

**排查要点**：这个链条里，**报错的那一行离真正的原因有两层**。看到「配置被重置」不要去修配置 —— 去 `Player.log` 里找**它之前的第一条 def 加载错误**。

（`%USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Player.log` —— 注意 `RimCrow_Realtime.log` **不记录 mod 元数据解析错误**，两个日志内容不同，必须都看。）

---

## 7. 做 CE 兼容时的固定流程

按顺序走，每一步都有验证手段，不要跳。

### 第 0 步：先确认「要做的是哪几类」

CE 兼容不是只有近战。一次维护通常同时涉及下列几类，**先分清范围再动手**，否则会漏项：

| 类别 | 要补/要改的东西 | 本手册在哪讲 |
|---|---|---|
| 远程武器 | 弹道、弹药、开火模式；`MakeGunCECompatible` 或手写 def | §3、§4 |
| 近战武器 | `ToolCE` 与穿透（`armorPenetrationSharp/Blunt`） | §2、§8.1 |
| 服装 / 护甲 | 把原版护甲值换算成 CE 的 mm / MPa | §1、§8 与各 mod 自己的换算比例 |
| 配方 | 缺 `RecipeDef` 的按 `Copy` 模板补 | §8.3 |
| 跨 mod 幂等 | 别人已补过的 def 不要重复补 | §8.5 |
| 改名失效 | `DamageDef` 之类被改名后引用失效 | §8.6 |

> 想直接把这些变成一句话让人去干：见 `使用参考.md` 第七节（判定 / 四类补法 / 重复检查三段）。

### 第 1 步：确认问题真的存在

```
rimworld_log_scan(action: "analyze")                  →  看错误簇
rimworld_log_scan(action: "grep", pattern: "...")     →  看原始行
node tools/ce-audit.mjs                               →  扫全部第三方 mod
node tools/ce-audit.mjs <packageId>                   →  只扫一个 mod
node tools/ce-audit.mjs --mods                        →  只看每个 mod 的计数
```

**不要凭印象。** 先确认这个症状在**当前**会话里真实出现，以及出现了多少次。

**`ce-audit.mjs` 报什么**：

| 发现类型 | 含义 |
|---|---|
| `tools-not-ce` | 这个 ThingDef 有 `<tools>`，但其中有 tool 不是 `ToolCE` → 会走第 2 节那条错误 |
| `ranged-maybe-unconverted` | 这个 ThingDef 有 `defaultProjectile` → **需要继续查那个弹丸**的 `<projectile>` 是不是 `ProjectilePropertiesCE` |

**它有一个明确看不见的东西，用之前必须知道**：它读的是**磁盘上的 mod 文件**，所以报的是**任何补丁应用之前**的状态。

- 源 mod 没转、但**你写的补丁转了**的武器，**照样会被列出来**
- 这不是误报，是**回答了另一个问题**：「哪些 mod 自带的 CE 数据是零」—— 那正是最该先看的地方
- 想知道**打完补丁之后**的状态，最省事的交叉验证是日志：未转换的近战武器会用
  `Trying to get stat MeleeDamageAverage from X which has no support for Combat Extended` 自报家门

> **这条限制值得反复提醒**：本仓在验证这个工具时，连续三次据「记忆中的数字」判定它算错了（先是把 2 个数成 4，后是把另一个文件的行数当成同一个文件），**三次都被脚本本身推翻**。**工具的输出要跟工具自己的中间产物对，不要跟印象对。**

### 第 2 步：读机制，不要读文档

本手册的每条结论都对应一份反编译证据。遇到本手册没覆盖的问题：

```powershell
# 反编译某个类型（工具链在工作区 _tools\ 下，按你自己的位置替换 <反编译器目录>）
dotnet <反编译器目录>\Decompile.dll <dll路径> <类型名子串> [--list]
dotnet <反编译器目录>\VerifyTarget.dll <dll路径> <类型名子串> <方法名>
```

**`--list` 先列类型名**，确认你要找的类型存在（避免「方法名拼错 → 找不到 → 以为是私有方法」这类误判）。

### 第 3 步：找同族的现成数值

**不要凭空编数值。** 优先顺序：

1. **CE 官方给同类原版武器/护甲打的补丁** —— `CombatExtended\Patches\Core\...`
2. **该 mod 自己的 CE 补丁**（如果它有 `CE` 目录或 `Patches/CE`）
3. **同作者、同档位的其它武器的 CE 数值**
4. **CE 自己的 mod 补丁** —— `CombatExtended\ModPatches\<mod名>\...`

**判定「同档位」要看这些，而不是看名字**：`techLevel`、`researchPrerequisite`（含 `baseCost`）、`recipeUsers`（哪个工作台）、`costList`、`WorkToMake`、`MaxHitPoints`。

一个实例：某把近战刀的 `researchPrerequisite` 是「仙材武器」（Spacer、`baseCost` 5000、有前置科研）、要 `FabricationBench`、材料是玻璃钢同级的自定义材料、`WorkToMake` 是它同 mod 三把远程武器的 2.5 倍 —— 这些合起来说明它是**顶级档**，所以穿透值取同族上限是合理的，而不是照普通中世纪刀给。

### 第 4 步：离线验证 xpath 和字段

**这一步不能省。** 写一个模拟脚本，用**真实的定义文件**、**真实地应用你的补丁**，然后检查：

- xpath 命中几个？（必须是预期的数字，不是 0）
- 产生的 XML 里每个字段名是否都是目标类型真实存在的成员？
- 原有的、你想保留的字段还在不在？

本仓有两个现成的模拟器可以照抄：

- `_tools\simulate-kiiro-patch.ps1` —— 复现一个自定义 `PatchOperation` 的实际产出的 XML 树
- `_tools\verify-minghongdao-patch.ps1` —— 应用 `PatchOperationReplace` 并逐个字段校验成员名

**为什么必须离线做**：补丁写错在游戏里的表现是「启动失败 → 配置被重置 → 进不去主菜单」。**用一次启动去试错，代价是几百个模组的启用列表。**

### 第 5 步：校验 XML 本身

```powershell
# 合法性 + 裸 & 检查
Get-ChildItem -Recurse -Filter *.xml | ForEach-Object {
  $t = Get-Content $_.FullName -Raw -Encoding UTF8
  try { [xml]$null = $t; "OK   $($_.Name)" } catch { "BAD  $($_.Name): $($_.Exception.Message)" }
  # 裸 & 单独查（有些错误只在特定解析器下暴露）
  ([regex]::Matches($t, '&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)')).Count
}
```

**本仓在这个检查上栽过两次**：一次是 `<description>` 里写了裸 `<li Class="...">`（会被当成真元素 → 标签不匹配），一次是裸 `&&`。**两次都是脚本抓到的，不是我看出来的。**

### 第 6 步：部署并验证

```powershell
# 必须先确认游戏没在跑，否则 DLL/文件被锁
Get-Process -Name 'RimWorld*'
```

部署后**逐字节核对**（哈希 + 重新解析 XML），然后让用户启动，再回到第 1 步确认症状消失。

---

## 8. 数值实例（本仓已落地的补丁）

> 这一节记录本仓实际写进补丁的数值和它们的依据。**作为「同族参照」的样本库使用，不要当公式。**
>
> **先说明这批数据的边界**：下面 7 个补丁只覆盖**近战 `ToolCE` / `DamageDef` / `RecipeDef`** 三类，**不含任何远程武器字段**，也**没有用过 `CombatExtended.PatchOperation*` 自定义操作类**（CE 类型只作为 value 里的 def 类出现）。第 3 节的枪械写法来自 CE 本体的补丁文件和 CE 的 ModPatches，来源不同。

### 8.1 近战 `ToolCE` 转换

| 补丁 | 武器 | label | capacities | power | cooldown | chance | sharp | blunt | 部位组 |
|---|---|---|---|---|---|---|---|---|---|
| `fix-dms-dragoon-ce` | DBMWE_ChainsawSword_open | Chainswordslash | Cut | 20 | 1 | — | **16** | **3** | Edge |
| | DBMWE_ChainsawSword_close | sweep | WG_HeavySweep | 30 | 2 | 3 | **24** | **15** | Edge |
| | DBMWE_ChainsawSword_close | Sawtoothlaceration | Scratch | 15 | 1 | 2 | **13** | **3** | Edge |
| | DBMWE_Dragoon_Battle_ChainsawSword_open | Chainswordslash | Cut | 40 | 1 | — | **26** | **4** | Edge |
| | DBMWE_Dragoon_Battle_ChainsawSword_close | sweep | WG_HeavySweep | 50 | 2 | 3 | **28** | **22** | Edge |
| | DBMWE_Dragoon_Battle_ChainsawSword_close | Sawtoothlaceration | Scratch | 20 | 1 | 2 | **17** | **4** | Edge |
| `fix-minghongdao-ce` | BrokenSword_Weapon_MingHongDao | 劈砍 | Cut | 80 | 1.5 | — | **28.0** | **6.0** | Edge |
| | BrokenSword_Weapon_MingHongDao | 戳刺 | Stab | 45 | 1 | — | **20.0** | **4.0** | Point |

**两处都遵守同一条纪律：`power` 与 `cooldownTime` 一律不动**，改动只落在 CE 才读的穿透字段上。

**链锯剑的推导方式（原文照抄）**：

```
      参考两个来源，逐条推导：
        1) Ratkin（NewRatkinPlus）「原型链锯剑」的 CE 补丁：威力30 → 锐20、钝2.88
           即切割型约为 锐=威力x0.67、钝=威力x0.10 —— 切割武器锐高钝低
        2) 同作者的龙骑兵战斧/剑：范围挥击 锐20.78~26.9、钝13.68~21.68
           —— 挥击型锐中等、钝高，且逐把武器单独调，不按威力等比推

      切割（启动状态）  照来源1的比值，并因本武器成本更高而略微上调；龙骑兵那把封顶在
                        作者刺击的 30.1 以内。
      挥击（待机状态）  落在来源2的区间内；龙骑兵威力最高，取区间上沿但不显著超出。
      撕裂（待机状态）  取同武器切割值的 0.8 倍（撕裂穿透力弱于切割）。

      坦白：这两个值没有权威换算依据，是照同作者同系列的量级类推；
            龙骑兵被「不超过作者上限」这条自设约束压住，所以它的穿甲/威力比低于开拓者。
```

**鸣鸿刀的推导方式（原文照抄）**：

```
      这把武器的定位：
        researchPrerequisite = BrokenSword_Research_XianCaiWeapon「萌螈仙材武器」
          techLevel = Spacer，baseCost = 5000，前置 Axolotl_Research_HeavenlyTopArmor
        recipeUsers = FabricationBench（精密装配台），skillRequirements Crafting 5
        costList = 玄铁 25 + 九曲紫竹 50 + 竹 25
        WorkToMake = 60000（同 mod 三把远程仙材武器是 24000）
        MaxHitPoints = 40000，buildingDamageFactor = 10
        特殊：180 度扇形 AoE、变招碎金（崩碎对方装备）

      同族（MoeLotl / Axolotl 系）现有的 CE 近战数值：
        power=70  sharp=28.0  blunt=4.5     <- 仙材档
        power=70  sharp=20.0  blunt=8.2
        power=90  sharp=3.5   blunt=10.8
        power=60  sharp=4.2   blunt=5.4

      取值：
        劈砍 power=80  -> sharp=28.0  blunt=6.0
          本武器 power 高于那把 power=70/sharp=28 的仙材武器，取该档上限
        戳刺 power=45  -> sharp=20.0  blunt=4.0
          按同族仙材档（power=70/sharp=20）折算
```

**注意这两处的差异**：链锯剑的武器是「同作者同系列」推出来的，鸣鸿刀是「按档位取同族上限」。**两者都标明了是推断**，并且都把「改哪个字段就能调」写进了注释。

### 8.2 `DamageDef.defaultArmorPenetration`（第 1 节第 ④ 条出口）

| 补丁 | defName | 值 |
|---|---|---|
| `fix-ce-deflect-armorpen` | `Axolotl_TearingCutRanged` | **34** |
| | `RangedStab` | **20** |

**依据（原文照抄，这段是第 1 节机制的最强佐证）**：

```
    取值依据（不是我编的）
      Axolotl_TearingCutRanged = 34
        这个伤害类型是 MoeLotl CE 补丁自己给投射物用的，而那个投射物上写着
        <armorPenetrationSharp>34</armorPenetrationSharp>。取同一个数，格挡路径与直接命中路径
        就得到一致的穿透，不再出现「同一发子弹，直接命中和被挡开算出两种穿透」。
        参照：CE 给近战斩击类 Slash_EnchantedSword 设的是 24。

      RangedStab = 20
        原版 Core 的远程伤害类型（Biotech / Anomaly 的能力以及原版远程武器会用到），CE 没有给它设值。
        20 取在 CE 近战斩击类的 24 与低穿透远程类 SwordBolt 的 1 之间，且明显低于硬编码的 50 ——
        也就是这个改动让格挡更接近真实强度，而不是更宽松。
```

**改动方向要写清楚（原文照抄）**：

```
      · 会让格挡后的钝击穿透从 50 变为 34 与 20。这是有意的修正：50 与任何数据都无关，
        而这两个数与对应伤害类型的真实穿透一致
```

**给 CE 作者的建议（本仓据此写过 issue 草稿）**：

```
  GetDeflectDamageInfo 的第 ⑤ 条兜底值 50 与任何 Def 数据无关，可能会让格挡意外地过于强力。
  可考虑在找不到来源时使用一个更保守的值，或在启动时提示哪些 DamageDef 缺 defaultArmorPenetration。
```

### 8.3 `RecipeDef`（用 Copy 模板的方式补缺失配方）

`fix-ce-155mm-anti` 与 `fix-fortress-155mm-anti` 补的是同一个缺失配方，**两个 mod 各自覆盖自己那一侧的弹药集**：

| 字段 | 值 |
|---|---|
| `defName` | `MakeAmmo_155mmHowitzerShell_Anti` |
| ParentName | `ArtilleryAmmoRecipeBase` |
| `researchPrerequisite Inherit="False"` | 空 |
| `researchPrerequisites` | `Mortars`、`CE_TurretHeavyWeapons`、`CE_AdvancedAmmo`、`MicroelectronicsBasics` |
| `workAmount` | **26000** |
| 材料 | 钢铁 **140** + 玻璃钢 **40** + 工业部件 **25** |
| `fixedIngredientFilter` | Steel、Plasteel、ComponentIndustrial |
| 产物 | `Ammo_155mmHowitzerShell_Anti` ×1 |

**为什么这么定（原文照抄）**：

```
    One RecipeDef, built by copying CE's own MakeAmmo_155mmHowitzerShell_EMP field for field so the
    routing, the unfinished-ammo step and the label behaviour match the other shells exactly. Only
    three things differ from that template:

      - the defName and the product, so it makes the Anti shell
      - the ingredients, scaled up for a superweapon: 140 steel, 40 plasteel, 25 components,
        against the EMP shell's 94 steel and 15 components
      - researchPrerequisites gains CE_AdvancedAmmo, and workAmount rises to 26000 from 18400, so
        it sits behind late-game research rather than beside the basic shells
```

**为什么分成两个 mod（原文照抄）**：

```
    The shell is listed in three ammo sets in total: Combat Extended's own
    AmmoSet_155mmHowitzerShell, plus these two Fortifications sets. Fixing any one of them alone
    leaves the error, because the injector walks every set. Each place is fixed by the mod that owns
    it, so a future update to either mod can be reasoned about independently.
```

> ⚠️ **已发现的文档不一致**：`fix-ce-155mm-anti` 的 `About.xml` 里写「兄弟 mod 用 FindMod 门控」，而 `fix-fortress-155mm-anti` 的实际实现是 `PatchOperationConditional`。**以实现为准。** 待修。

### 8.4 无 XML 的例外：Harmony 抑制一条误导性日志

`fix-ce-penetration-log` 没有任何 `<Operation>`，它是 Harmony DLL。**但它的分析过程是「读机制 → 定位到唯一触发条件 → 只跳过那一个条件」的范例**，值得作为写法样本：

```
    触发条件（反编译 CombatExtended.dll 后确认）
      报错来自 ArmorUtilityCE.TryPenetrateArmor，要同时满足四个条件才会打印：

        penAmount == 0 或 armorAmount == 0
          且 armor 的 ArmorRating_Sharp == 0
          且 armor 的 ArmorRating_Blunt == 0
          且 armor 的 ArmorRating_Heat  == 0
```

```
    penAmount 从哪来
      Verb_MeleeAttackCE 这样暴露攻击方的穿透值：

        public float ArmorPenetrationSharp =>
            ((tool as ToolCE)?.armorPenetrationSharp * PenetrationOtherMultipliers
                                                  * PenetrationSkillMultiplier * ...)
            .GetValueOrDefault();

      两个乘数恒大于零（1 + 近战技能/76，以及伤害系数的幂），所以整个表达式为零的唯一原因就是
      tool 不是 ToolCE —— 也就是攻击方用的不是 CE 化武器。
```

```
    为什么可以安全消除
      两个条件本身都无害：非 CE 攻击方的穿透为零是正常结果；三项护甲全为零的物品本来就没有护甲可穿，
      「穿透」它是个空操作。因此这条消息既没有揭示问题，也不影响任何结算。
```

```
    没有做什么（重要）
      不是无差别屏蔽日志。前缀会自己重算同样的三项护甲值，只在这三项全为零时才跳过原本的调用 ——
      也就是 CE 自己用来决定要不要打印的那个条件。如果这三项里有任何一个非零（这条消息本来要捕捉的
      情形），原方法照常执行，警告照常出现。
```

**这条的分寸值得学**：它是「精确复算原方法的判断条件，只跳过那一个分支」，而不是「按消息内容过滤日志」。后者会在条件变化时留下空洞。

### 8.5 跨 mod 幂等：三种写法

同一批补丁里出现了三种守卫，**按用途区分**：

| 写法 | 用途 | 实例 |
|---|---|---|
| **`PatchOperationTest` + `Replace`（Sequence 内）** | 目标**存在但可能已被转换**时，整体跳过 | `fix-dms-dragoon-ce`（4 处） |
| **`Conditional`（match=Replace，nomatch=Add）** | 字段**可能不存在也可能存在** | `fix-ce-deflect-armorpen`（2 处） |
| **`Conditional`（只有 nomatch=Add）** | **同名 def 只能声明一次**的跨 mod 幂等 | `fix-fortress-155mm-anti` |

**第一种的实测结论（原文照抄，这条很关键）**：

```
        已经转换过就整体跳过：这样若作者日后自己补了 CE 补丁，我们的值不会把它盖掉。
        实测确认：@Class 的大小写敏感（小写 @class 永远返回真），and not(...) 前缀在
        「换成两个工具」之后同样能被 XmlDocument.Parse 正常解析。
```

> ⚠️ **注意这条与第 5.1 节第 2 条的区别**：`@class`（小写）**不是「匹配不到」，而是永远返回真** —— 这是一个**失败开放**的行为，比匹配不到更危险，因为它会让守卫静默失效。

**第三种的理由（原文照抄）**：

```
    Both mods would otherwise declare the same defName, and two defs with one name cannot coexist.
    Rather than depending on which mod loaded first, the operation is wrapped in a Conditional that
    tests whether the recipe already exists:

      recipe present -> skip, whatever put it there
      recipe absent  -> add it

    So installing both mods, either one alone, or the Combat Extended one alone all yield exactly one
    recipe. No load-order assumption is needed for correctness; loadAfter is set only so the
    Fortifications copy is evaluated after the Combat Extended one in the common case.
```

**这是本仓最值得复用的一条设计**：**把「谁先加载」从正确性条件里去掉。**

### 8.6 跨版本改名：`DamageDef` 引用失效

`fix-dragonian-ce-damagedef` 是另一类问题：**CE 补丁跨版本引用了已删除的 Def**。

```
  症状  Could not resolve cross-reference: No Verse.DamageDef named DRM_Damage_FrostCoverd_after
        found to give to Verse.ExtraMeleeDamages

  原因  Dragonian Mix 在 1.6 把整条霜冻伤害线重做了：
          1.5  DRM_Frostbite / DRM_Damage_FrostCoverd / DRM_Damage_FrostCoverd_after
          1.6  DRM_Damage_Freeze / DRM_Damage_Freeze_ex          （前三个全部删除）
        配套的 CE 补丁还停在 1.5，跨版本引用没有跟着改名。
```

**它的写法很特别，值得单列**：**xpath 不含 defName**，靠 `@Class` + `label` 文本定位：

```
  //li[@Class="CombatExtended.ToolCE" and label[text()="tail"]]/extraMeleeDamages/li/def[text()="旧名"]
  //li[@Class="CombatExtended.ToolCE" and label[text()="tail"]]/surpriseAttack/extraMeleeDamages/li/def[text()="旧名"]
  //li[@Class="CombatExtended.ToolCE" and label[text()="physical-magic"]]/extraMeleeDamages/li/def[text()="旧名"]
```

**为什么必须拆成多条（原文照抄）**：

```
       这两处的层级不同，必须用两条 xpath：

         (a) 直接挂在工具下的附加伤害
             <li Class="CombatExtended.ToolCE"> ... <extraMeleeDamages> ... </extraMeleeDamages> </li>

         (b) 突袭附加伤害，多嵌套一层 surpriseAttack
             <li Class="CombatExtended.ToolCE"> ... <surpriseAttack>
                   <extraMeleeDamages> ... </extraMeleeDamages> </surpriseAttack> </li>

       只写 (a) 那条会漏掉 (b)，实测确认过：单条 xpath 只命中 1 处而不是 2 处。
```

**「改成哪个」要有判断，不能只按名字像（原文照抄）**：

```
    为什么改成 DRM_Damage_Freeze_ex，而不是复活旧的那个
      DRM_Damage_Freeze_ex 是 1.5 的 DRM_Damage_FrostCoverd_after 的直接后继：
      它同样把伤害挂到 DRM_Hediff_FrostCoverd_after 这个 Hediff 上，用途一一对应。

      不能指向 DRM_Damage_Freeze：它是父定义，workerClass 是 DragonianMix.DamageWorker_InstaKill
      （秒杀机制），把武器的附加伤害接到它上面会变成完全不同的东西。
```

> **这条是 §5.3「不要只看名字/最显眼字段」的另一个实例**：名字最像的那个（`DRM_Damage_Freeze`）**是错的**，因为它挂着秒杀 worker。

---

## 9. 载具（Vehicle Framework / VRF / CE 桥接）

载具相关的问题有一半**不报错**，只是"行为不对劲"（爆炸不结算、车不死、人不下来）。这一节把
2026-10 那轮排查里反复用到的五条固定下来，每条都写成「症状 → 机制 → 查法」。

### 9.1 载具 tick 的顺序：任何 tick 内异常都会跳过后面全部

**症状**：载具"反复爆炸但打不死"、"部件不掉血"、"AI 不动"、"人在车里不出来"。

**机制**（反编译 `Vehicles.VehiclePawn`，1.6.2144）：

```
BaseTickOptimized():
    TickShort(); TickRare(); sustainers.Tick();
    TickHandlers();      ← 乘员变更在这里可能抛 Collection was modified
    …
    TickExplosives();    ← 排在 TickHandlers 之后，异常就永不执行

Tick():
    BaseTickOptimized(); ← 抛出
    TickAllComps();      ← 跳过
    AITick();            ← 跳过
```

所以"爆炸永远不结束"不是爆炸数据的问题，而是**定时爆炸根本没被 tick**。同理"车不死"往往是
`TickAllComps()` 没跑。

**查法**：先看日志有没有 `Exception ticking <载具名>`，有就修那个异常，别先调数值。

### 9.2 载具空投：乘客在 inventory 里，而且车里 pawn 不是 Spawned

**症状**：敌方空投运输舱落地后，乘客一直坐在车里，直到舱快爆了才一起弹出。

**机制**：

- VRF 只在"载具战斗半径内有敌人"时才放人（武装运输车 = 炮塔 `MaxRange`，普通运输车 35 格，其他 22 格）；
  没敌人就 `return null`，人继续待命，直到载具被摧毁时 `DisembarkAll()` 一次性弹出。
- 驾驶位（`HandlingType.Movement`）与炮手位（`HandlingType.Turret`）被 `IsManipulatingOrManning` 过滤，
  **永远不放下去** —— "只留驾驶员和炮手"本来就是既有行为。
- 这型舱常常**只有驾驶座**，乘客装在 `AllInventoryPawns` 里，要用 `DisembarkAllFromInventory()` 才放得出来。
- 判"是不是空投舱"不要硬编码 defName，用 `VRF_TransportUtil.IsSiegeDropVehicle(vehicle)`（由 `droppod` 标签驱动）。
- 判"刚落地"用 `Thing.spawnedTick`（`SpawnSetup` 时写入），比"落地动画结束"更可靠。

**最容易踩的一条**：座位上的乘客 `pawn.Spawned == false`（它们在载具的 `ThingOwner` 里）。
按 `Spawned` 过滤会把所有乘客静默丢掉 —— 本仓就这么错过一次。

**查法**：写一次性探针，打印 `handler 数`、每个 handler 的 `role.HandlingTypes`（1=Movement、2=Turret、0=乘客）
与 `thingOwner` 里的 pawn 数；再打印 `spawnedTick / IsSiegeDrop / 派系`。一行就能定位卡在哪条。

### 9.3 CE 给 NPC 装弹药：`totalWeight=0` 就意味着这把枪没有弹药

**症状**：袭击单位"有枪但没弹药"，打一梭子就哑巴；日志里
`RandomElementByWeight with totalWeight=0 - use TryRandomElementByWeight`。

**机制**（反编译 `CombatExtended.LoadoutPropertiesExtension.LoadWeaponWithRandAmmo`）：

```csharp
IEnumerable<AmmoDef> availableAmmo = ammoSet.ammoTypes
    .Where(a => a.ammo != null && a.ammo.alwaysHaulable && !a.ammo.menuHidden
             && (a.ammo.generateAllowChance > 0f || …被 forced/weighted 类别命中…))
    .Select(a => a.ammo);
ammoDef = availableAmmo.RandomElementByWeight(a => a.generateAllowChance);   // ← 总权重 0 就抛
```

某个 `ammoSet` 里**所有弹药 `generateAllowChance` 都是 0**（或全被过滤掉）时，这里抛异常，
该枪的 NPC 一发备弹都拿不到。

**查法**：按武器找到它的 `ammoSet`，逐条看 `ammoTypes` 里每个 `AmmoDef` 的 `generateAllowChance`；
求和为 0 就是它。修法优先级：修 ammoSet 数据 > 兜底（权重 0 时取第一个有效弹药）。

**注意**：CE 只给 NPC 配"一梭子"级别的备弹，没有额外补弹补丁；打空就没子弹属正常，
"一发都没有"才是这条。

### 9.4 载具耐久 NaN：会自传播，界面表现为 `-2147483648%`

**症状**：载具耐久显示 `-2147483648%`、"结构强度"整行消失、`VVE Movement Controller` 显示
`Speed: 0.00 / NaN`、`Path % Passed: 744.3%`。

**机制**：`-2147483648` 是 `int.MinValue`，也就是 **NaN 转整数**的结果。而 CE 的载具桥
（`VehiclesCompat.VehicleArmorPatch.DamageComponent`）用 `component.health / 50f` 当第二层护甲：
**耐久一旦是 NaN，护甲就是 NaN，算出来的 `damageAmount` 也是 NaN**，于是每次命中都把 NaN 再写回去。

诊断上要分清两种 NaN：

- `dinfo.Amount` 正常、`damageAmount` 是 NaN → NaN 来自"耐久已坏"的自传播（本条）
- `dinfo.Amount` 本身是 NaN → 污染在更上游的伤害来源

**查法**：在 `DamageComponent` 上加前缀，命中前先看 `component.health` 是不是 NaN（是就先重置为
`MaxHealth` 再结算），并对 `damageAmount`/`dinfo.Amount` 为 NaN 的调用直接跳过（绝不写入）。
顺带把 `dinfo.Def.defName` 与 `dinfo.Instigator` 记一次，能直接指认生产 NaN 的伤害与来源。

**注意**：`VehicleComponent.SetHealth` 内部是 `Mathf.Clamp(health, 0, MaxHealth)`，
而 `Mathf.Clamp(NaN, …)` 仍然是 NaN —— 所以**已坏的部件不会自己好**，必须显式重置。

### 9.5 Harmony：抽象方法不能打补丁

**症状**：`System.ArgumentException: You can only patch implemented methods/constructors.
Patch the declared method virtual …::TryGiveJob(… ) instead.`

**机制**：`typeof(子类).GetMethod("方法名")` 会返回**继承来的抽象声明**，Harmony 拒绝打补丁。
本仓在 `JobGiver_AIDefendPoint.TryGiveJob` 上踩过（它继承自 `JobGiver_AIFightEnemy`）。

**查法**：从具体类型沿 `BaseType` 向上找第一个 `BindingFlags.DeclaredOnly` 且 `!IsAbstract` 的实现：

```csharp
for (Type t = type; t != null && t != typeof(object); t = t.BaseType) {
    MethodInfo m = t.GetMethod(name, declared | Instance, null, sig, null);
    if (m != null && !m.IsAbstract) return m;
}
```

打完补丁注意语义：挂在祖先方法上的 postfix 会对其**所有子类**生效，条件要写窄。

---
## 10. 相关手册

| 主题 | 位置 |
|---|---|
| 日志分析插件总览、命令、工具清单 | `OPERATIONS.md` |
| 把本插件移植到别的机器 | `PORTING.md` |
| 生成本仓风格的补丁 mod（含 About.xml 结构） | `OPERATIONS.md` §6 |
| 「配置被重置 / 进不去主菜单」的完整因果链 | `OPERATIONS.md` |
| 可直接复制给 DSH 的 CE 一句话清单 | `使用参考.md` 第七节 |

---

## 11. 本手册的维护约定

- **凡是反编译得到的结论，写明代码位置和证据文件。**
- **凡是推断的数值，标注「推断」和它的参照来源。**
- **凡是实机验证过的，写明验证方式。**
- 新增一条坑时，同时写明「它的错误表现是什么」—— 下次才能靠症状反查。
