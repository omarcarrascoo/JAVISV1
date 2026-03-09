import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Message, Interaction } from 'discord.js';
import 'dotenv/config';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs'; 
import path from 'path'; 

import { TARGET_REPO_PATH, setActiveProject, WORKSPACE_DIR } from './src/config.js';
import { prepareWorkspace, createPullRequest } from './src/git.js';
import { getProjectTree, getProjectMemory } from './src/scanner.js';
import { getFigmaContext } from './src/figma.js';
import { takeSnapshot } from './src/snapshot.js';
import { generateAndWriteCode } from './src/ai.js';

const execPromise = util.promisify(exec);

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]});

const sessionStore = new Map<string, string>();

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot || (message.channel as any).name !== 'jarvis-dev') return;

    const isIteration = !!message.reference;

    const replyMessage = await message.reply(
        isIteration 
        ? '🤖 Acknowledged. Agent waking up for iteration...' 
        : '🤖 Acknowledged. Preparing a fresh workspace...'
    );

    const threadName = message.content.length > 20 
        ? `🧠 Jarvis Logs - ${message.content.substring(0, 20)}...` 
        : `🧠 Jarvis Logs - ${message.content}`;
        
    const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 60,
    });

    try {
        // Solo limpiamos y preparamos el workspace si es un requerimiento nuevo
        if (!isIteration) {
            await prepareWorkspace();
        }
        
        const figmaData = await getFigmaContext(message.content);
        if (figmaData) await thread.send('🎨 Figma link detected. Analyzing design...');
        
        const projectTree = getProjectTree(TARGET_REPO_PATH);
        const projectMemory = getProjectMemory(TARGET_REPO_PATH);
        
        // 👇 NUEVO: Notificación en Discord de que la memoria fue cargada
        if (projectMemory) {
            await thread.send('🧠 UnityRC memory loaded. Applying architectural rules...');
        }
        
        const finalPrompt = isIteration 
            ? `We are iterating on the current code. Keep the recent changes but apply this correction: "${message.content}"` 
            : message.content;

        const { targetRoute, commitMessage, tokenUsage } = await generateAndWriteCode(
            finalPrompt, figmaData, projectTree, projectMemory,
            async (statusMsg, thought) => {
                let logMessage = `**${statusMsg}**`;
                if (thought && thought !== "") {
                    logMessage += `\n> 💭 *${thought.replace(/\n/g, '\n> ')}*`;
                }
                await thread.send(logMessage).catch(() => {});
            }
        );
        
        const sessionId = Date.now().toString().slice(-6);
        sessionStore.set(sessionId, commitMessage);
        
        await thread.send(`📸 Code generated. Navigating to \`${targetRoute}\` to take snapshot...`);
        
        const { snapshotPath, publicUrl, localUrl, warning } = await takeSnapshot(targetRoute);

        // Capturar el diff de Git antes de enviar el mensaje
        const { stdout: diffOutput } = await execPromise(`git diff`, { cwd: TARGET_REPO_PATH }).catch(() => ({ stdout: '' }));
        let diffPath = null;
        if (diffOutput && diffOutput.trim() !== '') {
            diffPath = path.join(WORKSPACE_DIR, `changes_${sessionId}.diff`);
            fs.writeFileSync(diffPath, diffOutput);
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve_${sessionId}`).setLabel('✅ Approve & PR').setStyle(ButtonStyle.Success),
            // Botón rojo destructivo explícito
            new ButtonBuilder().setCustomId(`reject_${sessionId}`).setLabel('🗑️ Revert (Start Over)').setStyle(ButtonStyle.Danger),
        );

        // Instrucciones claras para iterar
        const finalContent = `✨ **Ready!**\n📝 **Commit:** \`${commitMessage}\`\n💰 **Tokens Used:** \`${tokenUsage.toLocaleString()}\`\n🏠 **Local:** ${localUrl}\n📱 **Mobile (Wi-Fi):** ${publicUrl ? publicUrl : 'Unavailable'}\n\n👉 **¿Quieres iterar?** Simplemente RESPONDE a este mensaje con tus correcciones.\n${warning ? `\n⚠️ *${warning}*` : ''}`;

        // Adjuntar la foto y el archivo de código (.diff)
        const filesToAttach = [];
        if (snapshotPath) filesToAttach.push(new AttachmentBuilder(snapshotPath));
        if (diffPath) filesToAttach.push(new AttachmentBuilder(diffPath));

        if (filesToAttach.length > 0) {
            await replyMessage.edit({ content: finalContent, files: filesToAttach, components: [row] });
        } else {
            await replyMessage.edit({ content: finalContent, components: [row] });
        }

        await thread.send("✅ Task completed. Archiving thread.");
        await thread.setArchived(true);

    } catch (error: any) {
        console.error(error);
        const safeError = error.message.length > 1500 ? error.message.substring(0, 1500) + '...' : error.message;
        
        await thread.send(`❌ **CRITICAL ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
        await replyMessage.edit(`❌ Error encountered. Please check the thread logs for details.`);
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    
    // 1. MANEJO DE BOTONES
    if (interaction.isButton()) {
        const [action, sessionId] = interaction.customId.split('_');

        if (action === 'approve') {
            await interaction.update({ content: '🚀 Creating PR with exact commit message...', components: [], files: [] });
            try {
                const exactCommitMessage = sessionStore.get(sessionId) || 'feat: update from Jarvis';
                const prUrl = await createPullRequest(`req-${sessionId}`, exactCommitMessage);
                await interaction.followUp(`✅ **Pull Request successfully created!**\n🔗 Review here: ${prUrl}`);
                sessionStore.delete(sessionId);
            } catch (error) {
                console.error(error);
                await interaction.followUp(`❌ Failed to create PR.`);
            }
        } else if (action === 'reject') {
            // Abortar misión: Limpiamos los archivos modificados localmente
            await execPromise(`git reset --hard HEAD`, { cwd: TARGET_REPO_PATH }).catch(() => {});
            await execPromise(`git clean -fd`, { cwd: TARGET_REPO_PATH }).catch(() => {});
            
            await interaction.update({ 
                content: '🗑️ **Cambios revertidos.** El repositorio ha vuelto a su estado original limpio.\nPuedes enviar un nuevo mensaje para intentar otra aproximación.', 
                components: [], 
                files: [] 
            });
            sessionStore.delete(sessionId);
        }
        return;
    }

    // 2. MANEJO DE SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'status') {
            await interaction.reply(`🤖 **Estado Actual:**\nJarvis está enfocado en el repositorio: \`${process.env.GITHUB_REPO}\``);
        }

        if (commandName === 'workon') {
            const repoName = interaction.options.getString('repo', true);
            setActiveProject(repoName);
            
            await interaction.reply(`🔄 **Cambio de Contexto:**\nJarvis ha movido su atención a \`${repoName}\`.\nEscaneando arquitectura...`);
            
            try {
                await prepareWorkspace();
                await interaction.followUp(`✅ Arquitectura de \`${repoName}\` lista para trabajar.`);
            } catch (error: any) {
                await interaction.followUp(`⚠️ Error al preparar el workspace: ${error.message}`);
            }
        }

        if (commandName === 'init') {
            const type = interaction.options.getString('type', true);
            const name = interaction.options.getString('name', true);
            
            await interaction.reply(`🏗️ **Construyendo Base:** Iniciando scaffold de \`${name}\` (${type})...\n*Por favor espera, esto puede tomar 1 o 2 minutos.*`);
            
            try {
                if (type === 'expo') {
                    await execPromise(`npx create-expo-app ${name} --template blank-typescript`, { cwd: './workspaces' });
                } else if (type === 'nest') {
                    await execPromise(`npx @nestjs/cli new ${name} --package-manager npm --skip-git`, { cwd: './workspaces' });
                }
                
                await interaction.followUp(`✅ **Proyecto \`${name}\` creado exitosamente.**\n👉 Usa \`/workon repo:${name}\` para decirle a Jarvis que empiece a trabajar en él.`);
            } catch (error: any) {
                await interaction.followUp(`❌ Error al crear el proyecto: ${error.message}`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN as string);
console.log('🤖 Jarvis Architect listening on Discord...');